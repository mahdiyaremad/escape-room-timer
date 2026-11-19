#!/usr/bin/env python3
"""BLACKROOM hub — one file, own sync, not ntfy.

Copy this folder to the server and run:

    python3 server.py

Listens on 0.0.0.0:6985. Panels connect straight to the IP
(http://5.57.39.218:6985) so a DNS name is not in the path.

Open TCP 6985 on the firewall. WebSocket stays up with protocol pings.
Camera frames, photos, and speak clips are stored here and fanned out
to every connected panel.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import socket
import struct
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

HOST = "0.0.0.0"
PORT = 6985
ROOM_KEY = "brhub-7k3m9qx2-6985"
PANEL_PASSWORD = "blackroom"
PUBLIC_BASE = "http://5.57.39.218:6985"
CHANNEL = "countdown-link"
WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_MEDIA = 32
MAX_MEDIA_BYTES = 8 * 1024 * 1024
MAX_FRAME_BYTES = 2 * 1024 * 1024
MAX_WS_BYTES = 8 * 1024 * 1024

LOCK = threading.Lock()
CLIENTS = []  # {"id","role","sock","watching","alive"}
MEDIA = {}  # id -> {"body","mime","kind","at"}
MEDIA_ORDER = []
FRAME_JPEG = b""
FRAME_SEQ = 0
FRAME_COND = threading.Condition()
MJPEG_VIEWERS = 0
LAST = {"state": None, "cover": None}
SEEN = {}
STARTED = time.time()


def public_base() -> str:
    return PUBLIC_BASE.rstrip("/")


def panel_token() -> str:
    return hmac.new(ROOM_KEY.encode("utf-8"), PANEL_PASSWORD.encode("utf-8"), hashlib.sha256).hexdigest()


def cookie_value(header: str, name: str) -> str:
    for part in (header or "").split(";"):
        part = part.strip()
        if part.startswith(name + "="):
            return part.split("=", 1)[1].strip()
    return ""


def password_ok(password: str) -> bool:
    got = password.encode("utf-8")
    want = PANEL_PASSWORD.encode("utf-8")
    if len(got) != len(want):
        return False
    return hmac.compare_digest(got, want)


def panel_authed(handler) -> bool:
    got = cookie_value(handler.headers.get("Cookie") or "", "br_panel")
    if len(got) != len(panel_token()):
        return False
    return hmac.compare_digest(got, panel_token())


def login_page(bad: bool) -> str:
    note = "<p class=\"err\">رمز اشتباه است</p>" if bad else ""
    return """<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BLACKROOM</title>
  <style>
    body { margin:0; min-height:100vh; display:grid; place-items:center; background:#0b0d0c; color:#d7ddd6; font-family:Tahoma,sans-serif; }
    form { width:min(360px, calc(100%% - 32px)); background:#141916; border:1px solid #2a322c; border-radius:14px; padding:22px; }
    strong { display:block; letter-spacing:.18em; color:#7e8b83; font-size:12px; }
    h1 { margin:6px 0 16px; font-size:28px; font-weight:500; }
    input { width:100%%; box-sizing:border-box; background:#0f1311; color:#d7ddd6; border:1px solid #2a322c; border-radius:10px; padding:12px; font:16px Tahoma,sans-serif; }
    button { margin-top:12px; width:100%%; border:0; border-radius:10px; padding:12px; background:#c6f5a4; color:#10140e; font:700 15px Tahoma,sans-serif; cursor:pointer; }
    .err { color:#ff7a6a; font-size:13px; margin:0 0 10px; }
  </style>
</head>
<body>
  <form method="post" action="/login">
    <strong>BLACKROOM</strong>
    <h1>ورود</h1>
    %s
    <input type="password" name="password" autocomplete="current-password" autofocus required placeholder="رمز">
    <button type="submit">ورود به پنل</button>
  </form>
</body>
</html>""" % note


def panel_html() -> str:
    here = Path(__file__).resolve().parent
    path = here / "remote-control.html"
    if not path.is_file():
        path = here.parent / "remote-control.html"
    if not path.is_file():
        return "<p>remote-control.html missing</p>"
    html = path.read_text(encoding="utf-8")
    boot = {"baseUrl": public_base(), "key": ROOM_KEY, "pin": PANEL_PASSWORD, "room": "BLACKROOM"}
    with LOCK:
        state_msg = LAST.get("state")
    if isinstance(state_msg, dict) and isinstance(state_msg.get("state"), dict):
        boot["state"] = state_msg["state"]
        if isinstance(state_msg.get("serverNow"), (int, float)):
            boot["serverNow"] = state_msg["serverNow"]
    injected = "window.REMOTE_BOOT = %s;" % json.dumps(boot, ensure_ascii=False)
    needle = "window.REMOTE_BOOT = window.REMOTE_BOOT || null;"
    if needle in html:
        html = html.replace(needle, injected, 1)
    return html


def authorized(handler, parsed) -> bool:
    if not ROOM_KEY:
        return True
    qs = parse_qs(parsed.query or "")
    key = (qs.get("key") or [""])[0]
    if not key:
        key = handler.headers.get("X-Room-Key") or ""
    return key == ROOM_KEY


def ws_accept(key: str) -> str:
    digest = hashlib.sha1((key + WS_MAGIC).encode("utf-8")).digest()
    return base64.b64encode(digest).decode("ascii")


def ws_send(sock, opcode: int, data: bytes) -> None:
    header = bytearray([0x80 | (opcode & 0x0F)])
    n = len(data)
    if n < 126:
        header.append(n)
    elif n < 65536:
        header.append(126)
        header.extend(struct.pack("!H", n))
    else:
        header.append(127)
        header.extend(struct.pack("!Q", n))
    sock.sendall(header + data)


def ws_send_text(sock, text: str) -> None:
    ws_send(sock, 0x1, text.encode("utf-8"))


def _recv_exact(sock, n: int) -> bytes:
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            return b""
        buf.extend(chunk)
    return bytes(buf)


def ws_recv(sock, timeout: float = 60.0):
    sock.settimeout(timeout)
    try:
        hdr = _recv_exact(sock, 2)
    except (TimeoutError, socket.timeout):
        return None
    except OSError:
        return ("close", b"")
    if not hdr or len(hdr) < 2:
        return ("close", b"")
    opcode = hdr[0] & 0x0F
    masked = (hdr[1] & 0x80) != 0
    length = hdr[1] & 0x7F
    if length == 126:
        ext = _recv_exact(sock, 2)
        if len(ext) < 2:
            return ("close", b"")
        length = struct.unpack("!H", ext)[0]
    elif length == 127:
        ext = _recv_exact(sock, 8)
        if len(ext) < 8:
            return ("close", b"")
        length = struct.unpack("!Q", ext)[0]
    if length > MAX_WS_BYTES:
        return ("close", b"")
    mask = _recv_exact(sock, 4) if masked else b""
    if masked and len(mask) < 4:
        return ("close", b"")
    data = _recv_exact(sock, length) if length else b""
    if length and len(data) < length:
        return ("close", b"")
    if masked:
        data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    return (opcode, data)


def remember_id(mid: str) -> bool:
    if not mid:
        return False
    now = time.time()
    with LOCK:
        if mid in SEEN:
            return True
        SEEN[mid] = now
        if len(SEEN) > 800:
            old = sorted(SEEN, key=lambda k: SEEN[k])[:400]
            for k in old:
                SEEN.pop(k, None)
    return False


def remember_room(msg: dict) -> None:
    kind = str(msg.get("type") or "")
    with LOCK:
        if kind == "state" and isinstance(msg.get("state"), dict):
            LAST["state"] = msg
        elif kind == "tick" and isinstance(LAST.get("state"), dict):
            wrapped = dict(LAST["state"])
            state = dict(wrapped.get("state") or {})
            for key in ("remainingMs", "endsAt", "status", "revision", "msPerTick"):
                if key in msg and msg.get(key) is not None:
                    state[key] = msg.get(key)
            wrapped["state"] = state
            if isinstance(msg.get("serverNow"), (int, float)):
                wrapped["serverNow"] = msg.get("serverNow")
            LAST["state"] = wrapped
        elif kind == "cover":
            LAST["cover"] = msg


def client_snapshot():
    with LOCK:
        return list(CLIENTS)


def drop_client(entry) -> None:
    entry["alive"] = False
    with LOCK:
        if entry in CLIENTS:
            CLIENTS.remove(entry)
    try:
        entry["sock"].close()
    except Exception:
        pass


def send_frame(entry, opcode: int, data: bytes) -> bool:
    if not entry.get("alive", True):
        return False
    try:
        with entry["send_lock"]:
            ws_send(entry["sock"], opcode, data)
        return True
    except Exception:
        drop_client(entry)
        return False


def send_client(entry, text: str) -> bool:
    return send_frame(entry, 0x1, text.encode("utf-8"))


def broadcast(msg: dict, exclude_id: str = "") -> None:
    raw = json.dumps(msg, ensure_ascii=False)
    for entry in client_snapshot():
        if exclude_id and entry.get("id") == exclude_id:
            continue
        send_client(entry, raw)


def reply(entry, msg: dict) -> None:
    send_client(entry, json.dumps(msg, ensure_ascii=False))


def cam_viewers() -> int:
    with LOCK:
        watchers = sum(1 for c in CLIENTS if c.get("watching") and c.get("alive", True))
        http = MJPEG_VIEWERS
    return watchers + http


def store_media(body: bytes, mime: str, kind: str) -> dict:
    mid = uuid.uuid4().hex[:12]
    item = {"body": body, "mime": mime or "application/octet-stream", "kind": kind or "file", "at": time.time()}
    with LOCK:
        MEDIA[mid] = item
        MEDIA_ORDER.append(mid)
        while len(MEDIA_ORDER) > MAX_MEDIA:
            old = MEDIA_ORDER.pop(0)
            MEDIA.pop(old, None)
    url = "%s/media/%s?key=%s" % (public_base(), mid, ROOM_KEY)
    return {"id": mid, "url": url, "mime": item["mime"], "kind": item["kind"], "size": len(body)}


def note_frame(jpeg: bytes) -> int:
    global FRAME_JPEG, FRAME_SEQ
    with FRAME_COND:
        FRAME_JPEG = jpeg
        FRAME_SEQ += 1
        seq = FRAME_SEQ
        FRAME_COND.notify_all()
    return seq


def handle_ws_message(entry, msg: dict) -> None:
    if not isinstance(msg, dict):
        return
    if msg.get("channel") not in (None, "", CHANNEL):
        return
    msg["channel"] = CHANNEL
    mid = str(msg.get("id") or "")
    if remember_id(mid):
        return
    kind = str(msg.get("type") or "")
    if kind == "cam-watch":
        entry["watching"] = bool(msg.get("on"))
        return
    if kind in ("ping", "heartbeat", "hub-ping"):
        return
    if kind in ("hello", "request"):
        with LOCK:
            state_msg = LAST.get("state")
            cover_msg = LAST.get("cover")
        if isinstance(state_msg, dict):
            reply(entry, state_msg)
        if isinstance(cover_msg, dict):
            reply(entry, cover_msg)
        reply(
            entry,
            {
                "channel": CHANNEL,
                "from": "server",
                "clientId": "hub",
                "type": "peers",
                "peers": {"hub": True, "clients": len(client_snapshot()), "camViewers": cam_viewers()},
            },
        )
        return
    remember_room(msg)
    broadcast(msg, exclude_id=str(entry.get("id") or ""))


def serve_client(entry) -> None:
    sock = entry["sock"]
    try:
        while entry.get("alive", True):
            frame = ws_recv(sock, 60.0)
            if frame is None:
                continue
            opcode, payload = frame
            if opcode in (0x8, "close"):
                break
            if opcode == 0x9:
                try:
                    ws_send(sock, 0xA, payload)
                except Exception:
                    break
                continue
            if opcode == 0xA:
                continue
            if opcode != 0x1:
                continue
            try:
                msg = json.loads(payload.decode("utf-8"))
            except Exception:
                continue
            handle_ws_message(entry, msg)
    except Exception:
        pass
    finally:
        drop_client(entry)


def ping_loop() -> None:
    while True:
        time.sleep(15)
        for entry in client_snapshot():
            send_frame(entry, 0x9, b"")


class Handler(BaseHTTPRequestHandler):
    server_version = "BlackroomHub/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        line = fmt % args
        if "GET /cam.mjpg" in line or "GET /health" in line:
            return
        print("[%s] %s" % (self.log_date_time_string(), line), flush=True)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Kind, X-Room-Key, X-Filename")
        self.send_header("Cache-Control", "no-store")

    def _json(self, code: int, payload):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _html(self, code: int, html: str):
        raw = html.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _reject(self):
        self._json(401, {"ok": False, "error": "bad key"})

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path == "/":
            if panel_authed(self):
                self._html(200, panel_html())
            else:
                self._html(200, login_page(False))
            return

        if path == "/health":
            with LOCK:
                rev = 0
                state_msg = LAST.get("state")
                if isinstance(state_msg, dict) and isinstance(state_msg.get("state"), dict):
                    rev = int(state_msg["state"].get("revision") or 0)
            body = {
                "ok": True,
                "service": "blackroom-hub",
                "port": PORT,
                "publicBase": public_base(),
                "clients": len(client_snapshot()),
                "camViewers": cam_viewers(),
                "revision": rev,
                "uptime": int(time.time() - STARTED),
            }
            self._json(200, body)
            return

        if not authorized(self, parsed):
            self._reject()
            return

        if path == "/ws":
            self._websocket(parsed)
            return
        if path == "/cam.jpg":
            self._cam_jpg()
            return
        if path == "/cam.mjpg":
            self._cam_mjpg()
            return
        if path.startswith("/media/"):
            self._media_get(path[len("/media/") :])
            return
        self.send_error(404)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        length = int(self.headers.get("Content-Length") or 0)
        if length < 0 or length > MAX_MEDIA_BYTES:
            self._json(413, {"ok": False, "error": "too large"})
            return
        raw = self.rfile.read(length) if length else b""
        if path == "/login":
            form = parse_qs(raw.decode("utf-8", "replace"), keep_blank_values=True)
            password = (form.get("password") or [""])[0]
            if not password_ok(password):
                self._html(401, login_page(True))
                return
            self.send_response(303)
            self.send_header("Location", "/")
            self.send_header(
                "Set-Cookie",
                "br_panel=%s; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000" % panel_token(),
            )
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if not authorized(self, parsed):
            self._reject()
            return
        if path == "/cam/frame":
            if not raw or len(raw) > MAX_FRAME_BYTES:
                self._json(400, {"ok": False, "error": "empty frame"})
                return
            seq = note_frame(raw)
            self._json(200, {"ok": True, "seq": seq, "viewers": cam_viewers()})
            return
        if path == "/media":
            kind = (self.headers.get("X-Kind") or "file").strip().lower()[:24]
            mime = (self.headers.get("Content-Type") or "application/octet-stream").split(";")[0].strip()
            if not raw:
                self._json(400, {"ok": False, "error": "empty"})
                return
            saved = store_media(raw, mime, kind)
            event_type = "cam-photo" if kind == "photo" else "speak-clip" if kind == "speak" else "media"
            event = {
                "channel": CHANNEL,
                "from": "server",
                "clientId": "hub",
                "id": "hub-" + saved["id"],
                "type": event_type,
                "mediaId": saved["id"],
                "url": saved["url"],
                "mime": saved["mime"],
                "kind": kind,
                "size": saved["size"],
            }
            remember_id(event["id"])
            broadcast(event)
            self._json(200, {"ok": True, **saved})
            return
        self.send_error(404)

    def _cam_jpg(self):
        with FRAME_COND:
            jpeg = FRAME_JPEG
            seq = FRAME_SEQ
        if not jpeg:
            self._json(404, {"ok": False, "error": "no frame yet"})
            return
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("X-Frame-Seq", str(seq))
        self.send_header("Content-Length", str(len(jpeg)))
        self.end_headers()
        self.wfile.write(jpeg)

    def _cam_mjpg(self):
        global MJPEG_VIEWERS
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        self.send_header("Connection", "close")
        self.end_headers()
        with LOCK:
            MJPEG_VIEWERS += 1
        seq = -1
        try:
            while True:
                with FRAME_COND:
                    if FRAME_SEQ == seq:
                        FRAME_COND.wait(timeout=8)
                    jpeg = FRAME_JPEG
                    seq = FRAME_SEQ
                if not jpeg:
                    continue
                packet = (
                    b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                    + str(len(jpeg)).encode("ascii")
                    + b"\r\n\r\n"
                    + jpeg
                    + b"\r\n"
                )
                self.wfile.write(packet)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with LOCK:
                MJPEG_VIEWERS = max(0, MJPEG_VIEWERS - 1)

    def _media_get(self, name: str):
        mid = name.split("?", 1)[0].strip("/")
        if not mid or "/" in mid or ".." in mid:
            self.send_error(400)
            return
        with LOCK:
            item = MEDIA.get(mid)
        if not item:
            self.send_error(404)
            return
        body = item["body"]
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", item["mime"])
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _websocket(self, parsed):
        key = self.headers.get("Sec-WebSocket-Key")
        if not key:
            self.send_error(400, "missing websocket key")
            return
        qs = parse_qs(parsed.query or "")
        role = (qs.get("role") or ["remote"])[0][:24]
        client_id = (qs.get("clientId") or [""])[0][:80] or ("hub-" + uuid.uuid4().hex[:8])
        accept = ws_accept(key)
        self.close_connection = True
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        try:
            self.wfile.flush()
        except Exception:
            return
        sock = self.connection
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        except Exception:
            pass
        entry = {
            "id": client_id,
            "role": role,
            "sock": sock,
            "watching": False,
            "alive": True,
            "send_lock": threading.Lock(),
        }
        with LOCK:
            CLIENTS.append(entry)
        print("[hub] join %s %s" % (role, client_id), flush=True)
        serve_client(entry)
        print("[hub] leave %s %s" % (role, client_id), flush=True)


def main():
    threading.Thread(target=ping_loop, name="hub-ping", daemon=True).start()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print("BLACKROOM hub    %s" % public_base(), flush=True)
    print("bind             %s:%s" % (HOST, PORT), flush=True)
    print("websocket        ws://5.57.39.218:%s/ws" % PORT, flush=True)
    print("camera           %s/cam.mjpg" % public_base(), flush=True)
    print("sync             own websocket bus (not ntfy)", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye", flush=True)
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
