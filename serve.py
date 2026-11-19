#!/usr/bin/env python3
"""BLACKROOM server: static files + room hub + Persian TTS + Dahua camera proxy."""

from __future__ import annotations

import asyncio
import json
import mimetypes
import queue
import re
import shutil
import socket
import subprocess
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

import edge_tts
import requests
from requests.auth import HTTPDigestAuth

ROOT = Path(__file__).resolve().parent
TTS_DIR = ROOT / "_tts_cache"
CAP_DIR = ROOT / "_captures"
PORT = 8765
BIND = "0.0.0.0"
VOICE = "fa-IR-FaridNeural"
FFMPEG = shutil.which("ffmpeg") or r"C:\Users\Mahdiyar\AppData\Local\Microsoft\WinGet\Links\ffmpeg.exe"
CAM_CFG = {
    "host": "192.168.10.223",
    "user": "admin",
    "password": "",
    "channel": 1,
    "subtype": 0,
    "stream": "main",
    "previewScale": 0,
}
ROOM_CFG = {
    "bind": "0.0.0.0",
    "port": 8765,
    "adminPin": "blackroom",
    "roomName": "BLACKROOM",
    "publicUrl": "",
    "hub": {
        "enabled": True,
        "baseUrl": "http://5.57.39.218:6985",
        "key": "brhub-7k3m9qx2-6985",
    },
}

REC_PROC = None
REC_PATH = None
REC_LOCK = threading.Lock()

ROOM_LOCK = threading.Lock()
ROOM_STATE = None
ROOM_COVER = {"bgId": 0, "bgImage": ""}
ROOM_PEERS = {}  # clientId -> dict
ROOM_SSE = []  # list[queue.Queue]
ROOM_WS = []  # list[{"clientId","role","send","alive"}]
CHANNEL = "countdown-link"
WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def default_room_state():
    return {
        "remainingMs": 120000,
        "durationMs": 120000,
        "status": "idle",
        "msPerTick": 1000,
        "endsAt": None,
        "penaltyUntil": 0,
        "penaltyId": 0,
        "presentation": None,
        "revision": 0,
        "volume": 0.85,
        "pulse": True,
        "caption": "",
        "captionId": 0,
        "voiceFile": "",
        "voiceText": "",
        "voiceId": 0,
        "timerVisible": True,
        "notifId": 0,
        "sfxFile": "",
        "sfxId": 0,
        "sfxPlaying": False,
        "sfxVolume": 0.7,
        "heartFile": "",
        "heartId": 0,
        "heartPlaying": False,
        "heartVolume": 0.65,
        "hitFile": "",
        "hitId": 0,
        "bgImage": "",
        "bgId": 0,
        "winMode": False,
        "camera": False,
        "speak": False,
        "speakId": 0,
        "updatedAt": 0,
    }


def load_room():
    path = ROOT / "room.json"
    out = dict(ROOM_CFG)
    out["hub"] = dict(ROOM_CFG.get("hub") or {})
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                for k, v in data.items():
                    if k == "hub" and isinstance(v, dict):
                        merged = dict(out["hub"])
                        merged.update(v)
                        out["hub"] = merged
                    elif k in out:
                        out[k] = v
        except Exception:
            pass
    return out


def lan_addrs():
    found = []
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if ip and not ip.startswith("127.") and ip not in found:
                found.append(ip)
    except Exception:
        pass
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
        sock.close()
        if ip and not ip.startswith("127.") and ip not in found:
            found.insert(0, ip)
    except Exception:
        pass
    return found


def touch_peer(client_id: str, role: str):
    if not client_id:
        return
    now = time.time()
    with ROOM_LOCK:
        peer = ROOM_PEERS.get(client_id) or {"clientId": client_id, "role": role or "unknown"}
        peer["role"] = role or peer.get("role") or "unknown"
        peer["lastSeen"] = now
        ROOM_PEERS[client_id] = peer


def prune_peers(max_age: float = 8.0):
    now = time.time()
    with ROOM_LOCK:
        dead = [cid for cid, p in ROOM_PEERS.items() if now - float(p.get("lastSeen") or 0) > max_age]
        for cid in dead:
            ROOM_PEERS.pop(cid, None)


def peer_snapshot():
    prune_peers()
    now = time.time()
    with ROOM_LOCK:
        peers = [dict(p) for p in ROOM_PEERS.values()]
    displays = [p for p in peers if p.get("role") == "display" and now - float(p.get("lastSeen") or 0) < 3.5]
    controls = [p for p in peers if p.get("role") == "control" and now - float(p.get("lastSeen") or 0) < 3.5]
    return {
        "displayAlive": bool(displays),
        "controlCount": len(controls),
        "displayCount": len(displays),
        "peers": peers,
    }


def ntfy_cfg():
    return dict((load_room().get("ntfy") or {}))


def ntfy_enabled() -> bool:
    cfg = ntfy_cfg()
    return bool(cfg.get("enabled") and cfg.get("baseUrl") and cfg.get("topic"))


def slim_for_ntfy(msg: dict) -> dict:
    out = dict(msg or {})
    state = out.get("state")
    if isinstance(state, dict):
        out["state"] = slim_state(state)
    if out.get("bgImage") and str(out["bgImage"]).startswith("data:"):
        out["bgImage"] = ""
    out.pop("pin", None)
    return out


NTFY_LOCK = threading.Lock()
NTFY_STATUS = {
    "ok": False,
    "lastError": "",
    "lastOkAt": 0,
    "backoffUntil": 0,
    "activeBase": "",
}


def ntfy_mark(ok: bool, err: str = "", base: str = "") -> None:
    with NTFY_LOCK:
        NTFY_STATUS["ok"] = bool(ok)
        if ok:
            NTFY_STATUS["lastOkAt"] = time.time()
            NTFY_STATUS["lastError"] = ""
            NTFY_STATUS["backoffUntil"] = 0
            NTFY_STATUS["_delay"] = 5
            if base:
                NTFY_STATUS["activeBase"] = base
        else:
            NTFY_STATUS["lastError"] = str(err or "")[:240]
            delay = min(60, max(5, int(NTFY_STATUS.get("_delay") or 5) * 2))
            NTFY_STATUS["_delay"] = delay
            NTFY_STATUS["backoffUntil"] = time.time() + delay


def ntfy_snapshot() -> dict:
    with NTFY_LOCK:
        return {
            "ok": bool(NTFY_STATUS.get("ok")),
            "lastError": NTFY_STATUS.get("lastError") or "",
            "lastOkAt": int(NTFY_STATUS.get("lastOkAt") or 0),
            "activeBase": NTFY_STATUS.get("activeBase") or "",
        }


def ntfy_bases(cfg=None):
    """Only the configured server. No public fallback."""
    cfg = cfg or ntfy_cfg()
    primary = str(cfg.get("baseUrl") or "https://ntfy.mred.ir").rstrip("/")
    return [primary] if primary else []


def ntfy_auth_headers(cfg, base: str) -> dict:
    import base64

    token = str(cfg.get("token") or "").strip()
    if not token:
        return {}
    host = (urlparse(base).hostname or "").lower()
    # Do not send private mred credentials to public ntfy.sh.
    if host.endswith("ntfy.sh") and ":" in token and not token.startswith("tk_"):
        return {}
    if token.startswith("tk_") or ":" not in token:
        return {"Authorization": "Bearer %s" % token}
    # user:password → HTTP Basic
    return {"Authorization": "Basic %s" % base64.b64encode(token.encode("utf-8")).decode("ascii")}


def ntfy_payload_bytes(msg: dict) -> bytes:
    payload = json.dumps(slim_for_ntfy(msg), ensure_ascii=False).encode("utf-8")
    if len(payload) <= 3500:
        return payload
    light = slim_for_ntfy(msg)
    if isinstance(light.get("state"), dict):
        light["state"] = {
            k: light["state"].get(k)
            for k in (
                "revision",
                "status",
                "remainingMs",
                "durationMs",
                "msPerTick",
                "endsAt",
                "caption",
                "captionId",
                "timerVisible",
                "camera",
                "winMode",
                "sfxFile",
                "sfxId",
                "sfxPlaying",
                "heartFile",
                "heartId",
                "heartPlaying",
                "hitFile",
                "hitId",
                "voiceFile",
                "voiceText",
                "voiceId",
                "volume",
                "sfxVolume",
                "heartVolume",
                "pulse",
                "penaltyId",
                "penaltyUntil",
                "notifId",
                "bgId",
                "speak",
                "speakId",
                "updatedAt",
            )
            if k in light["state"]
        }
    light.pop("bgImage", None)
    return json.dumps(light, ensure_ascii=False).encode("utf-8")


def ntfy_publish(msg: dict) -> bool:
    if not ntfy_enabled():
        return False
    if str(msg.get("via") or "") == "ntfy":
        return False
    msg_type = str(msg.get("type") or "")
    if msg_type in ("ping", "heartbeat", "peers", "ready", "auth"):
        return False
    with NTFY_LOCK:
        if time.time() < float(NTFY_STATUS.get("backoffUntil") or 0):
            return False
    cfg = ntfy_cfg()
    topic = str(cfg.get("topic") or "").strip("/")
    if not topic:
        return False
    payload = ntfy_payload_bytes(msg)
    last_err = ""
    for base in ntfy_bases(cfg):
        url = "%s/%s" % (base, topic)
        headers = {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache": "no",
            "Title": "blackroom",
            "Tags": "blackroom,sync",
            "Priority": "3",
        }
        headers.update(ntfy_auth_headers(cfg, base))
        try:
            resp = requests.post(url, data=payload, headers=headers, timeout=8)
            if resp.status_code >= 400:
                last_err = "%s publish HTTP %s" % (base, resp.status_code)
                continue
            with NTFY_LOCK:
                switched = NTFY_STATUS.get("activeBase") != base
            ntfy_mark(True, base=base)
            if switched:
                print("[ntfy] active relay %s" % base, flush=True)
            return True
        except Exception as err:
            last_err = "%s %s" % (base, err)
            continue
    ntfy_mark(False, last_err or "publish failed")
    print("[ntfy] publish failed: %s" % (last_err or "unknown"), flush=True)
    return False


def publish_ntfy_snapshot() -> None:
    """Push the authoritative room state, including remaining time, to ntfy."""
    live = snapshot_live()
    ntfy_publish(
        {
            "channel": CHANNEL,
            "from": "server",
            "clientId": "server",
            "type": "state",
            "serverNow": live.get("serverNow"),
            "state": slim_state(live),
        }
    )


def room_clock_loop():
    """Keep every panel on the server clock. Local tick each second, ntfy every 2s."""
    last_ntfy = 0.0
    while True:
        time.sleep(1)
        with ROOM_LOCK:
            running = bool(
                ROOM_STATE
                and ROOM_STATE.get("status") == "running"
                and isinstance(ROOM_STATE.get("endsAt"), (int, float))
            )
            prev_rev = int((ROOM_STATE or {}).get("revision") or 0)
        if not running:
            continue
        live = snapshot_live()
        ended = live.get("status") == "ended" and int(live.get("revision") or 0) != prev_rev
        if ended:
            room_broadcast(
                {
                    "channel": CHANNEL,
                    "from": "server",
                    "clientId": "server",
                    "type": "state",
                    "serverNow": live.get("serverNow"),
                    "state": slim_state(live),
                }
            )
            continue
        relay = (time.time() - last_ntfy) >= 2.0
        room_broadcast(
            {
                "channel": CHANNEL,
                "from": "server",
                "clientId": "server",
                "type": "tick",
                "serverNow": live.get("serverNow"),
                "remainingMs": live.get("remainingMs"),
                "endsAt": live.get("endsAt"),
                "status": live.get("status"),
                "revision": live.get("revision"),
                "msPerTick": live.get("msPerTick") or 1000,
            },
            relay_ntfy=relay,
        )
        if relay:
            last_ntfy = time.time()


def ntfy_bridge_loop():
    """Subscribe to ntfy.mred.ir only and apply every room message into the local hub."""
    fail_delay = 5
    while True:
        if not ntfy_enabled():
            time.sleep(5)
            continue
        cfg = ntfy_cfg()
        topic = str(cfg.get("topic") or "").strip("/")
        connected = False
        for base in ntfy_bases(cfg):
            url = "%s/%s/json" % (base, topic)
            headers = {"Accept": "application/x-ndjson"}
            headers.update(ntfy_auth_headers(cfg, base))
            try:
                print("[ntfy] bridging %s" % url, flush=True)
                with requests.get(url, headers=headers, stream=True, timeout=(4, 120)) as resp:
                    if resp.status_code != 200:
                        ntfy_mark(False, "subscribe HTTP %s" % resp.status_code, base=base)
                        print("[ntfy] subscribe HTTP %s on %s" % (resp.status_code, base), flush=True)
                        continue
                    ntfy_mark(True, base=base)
                    fail_delay = 5
                    connected = True
                    print("[ntfy] connected %s" % base, flush=True)
                    publish_ntfy_snapshot()
                    for raw in resp.iter_lines(decode_unicode=True):
                        if not raw:
                            continue
                        try:
                            envelope = json.loads(raw)
                        except Exception:
                            continue
                        if envelope.get("event") == "keepalive":
                            ntfy_mark(True, base=base)
                            continue
                        if envelope.get("event") != "message":
                            continue
                        body = envelope.get("message") or ""
                        try:
                            msg = json.loads(body)
                        except Exception:
                            continue
                        if not isinstance(msg, dict) or msg.get("channel") != CHANNEL:
                            continue
                        msg["via"] = "ntfy"
                        process_room_message(msg, str(msg.get("pin") or ""))
                        ntfy_mark(True, base=base)
            except Exception as err:
                ntfy_mark(False, str(err), base=base)
                print("[ntfy] bridge reconnect (%s): %s" % (base, err), flush=True)
                continue
            # If stream ended cleanly, retry same selection promptly.
            if connected:
                break
        if not connected:
            time.sleep(fail_delay)
            fail_delay = min(60, fail_delay * 2)
        else:
            time.sleep(1)


HUB_LOCK = threading.Lock()
HUB_SEND = threading.Lock()
HUB_STATE = {"sock": None, "ok": False, "lastError": "", "lastOkAt": 0, "activeBase": ""}


def hub_cfg():
    return dict(load_room().get("hub") or {})


def hub_enabled() -> bool:
    cfg = hub_cfg()
    return bool(cfg.get("enabled") and cfg.get("baseUrl") and cfg.get("key"))


def hub_base() -> str:
    return str(hub_cfg().get("baseUrl") or "http://5.57.39.218:6985").rstrip("/")


def hub_snapshot() -> dict:
    with HUB_LOCK:
        return {
            "ok": bool(HUB_STATE.get("ok")),
            "lastError": HUB_STATE.get("lastError") or "",
            "lastOkAt": int(HUB_STATE.get("lastOkAt") or 0),
            "activeBase": HUB_STATE.get("activeBase") or "",
        }


def hub_mark(ok: bool, err: str = "", base: str = "") -> None:
    with HUB_LOCK:
        HUB_STATE["ok"] = bool(ok)
        if ok:
            HUB_STATE["lastOkAt"] = time.time()
            HUB_STATE["lastError"] = ""
            if base:
                HUB_STATE["activeBase"] = base
        else:
            HUB_STATE["lastError"] = str(err or "")[:240]


def _ws_client_send(sock, opcode: int, data: bytes) -> None:
    import os as _os
    import struct as _struct

    mask = _os.urandom(4)
    header = bytearray([0x80 | (opcode & 0x0F)])
    n = len(data)
    if n < 126:
        header.append(0x80 | n)
    elif n < 65536:
        header.append(0x80 | 126)
        header.extend(_struct.pack("!H", n))
    else:
        header.append(0x80 | 127)
        header.extend(_struct.pack("!Q", n))
    header.extend(mask)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    sock.sendall(bytes(header) + masked)


def hub_publish(msg: dict) -> bool:
    if not hub_enabled():
        return False
    if str(msg.get("via") or "") == "hub":
        return False
    kind = str(msg.get("type") or "")
    if kind in ("ping", "heartbeat", "peers", "ready", "auth", "hub-status", "ntfy-status"):
        return False
    with HUB_LOCK:
        sock = HUB_STATE.get("sock")
    if not sock:
        return False
    try:
        with HUB_SEND:
            _ws_client_send(sock, 0x1, json.dumps(msg, ensure_ascii=False).encode("utf-8"))
        return True
    except Exception as err:
        hub_mark(False, str(err))
        with HUB_LOCK:
            if HUB_STATE.get("sock") is sock:
                HUB_STATE["sock"] = None
                HUB_STATE["ok"] = False
        try:
            sock.close()
        except Exception:
            pass
        return False


def hub_push_snapshot() -> None:
    live = snapshot_live()
    hub_publish(
        {
            "channel": CHANNEL,
            "from": "server",
            "clientId": "lan-bridge",
            "id": "bridge-snap-%s" % uuid.uuid4().hex[:8],
            "type": "state",
            "serverNow": live.get("serverNow"),
            "state": slim_state(live),
        }
    )
    _ignored, cover = get_room_state()
    if cover.get("bgImage"):
        hub_publish(
            {
                "channel": CHANNEL,
                "from": "server",
                "clientId": "lan-bridge",
                "id": "bridge-cover-%s" % uuid.uuid4().hex[:8],
                "type": "cover",
                "bgId": cover.get("bgId") or 0,
                "bgImage": cover.get("bgImage") or "",
            }
        )


def camera_jpeg() -> bytes:
    cam = load_camera()
    auth = HTTPDigestAuth(cam["user"], cam["password"])
    url = "http://%s/cgi-bin/snapshot.cgi" % cam["host"]
    try:
        upstream = requests.get(url, auth=auth, timeout=(3, 12))
    except Exception:
        return b""
    if upstream.status_code != 200 or not upstream.content:
        return b""
    return upstream.content


def hub_upload(raw: bytes, kind: str, mime: str) -> None:
    if not raw or not hub_enabled():
        return
    cfg = hub_cfg()
    base = str(cfg.get("baseUrl") or "").rstrip("/")
    key = quote(str(cfg.get("key") or ""), safe="")
    try:
        requests.post(
            "%s/media?key=%s" % (base, key),
            data=raw,
            headers={"Content-Type": mime, "X-Kind": kind},
            timeout=12,
        )
    except Exception as err:
        print("[hub] upload %s failed: %s" % (kind, err), flush=True)


def hub_cam_loop() -> None:
    """Push Dahua stills while a remote panel is watching the hub stream."""
    while True:
        time.sleep(0.4)
        if not hub_enabled():
            continue
        cfg = hub_cfg()
        base = str(cfg.get("baseUrl") or "").rstrip("/")
        key = quote(str(cfg.get("key") or ""), safe="")
        try:
            resp = requests.get("%s/health?key=%s" % (base, key), timeout=4)
            info = resp.json() if resp.ok else {}
        except Exception:
            continue
        if int(info.get("camViewers") or 0) <= 0:
            continue
        jpeg = camera_jpeg()
        if not jpeg:
            time.sleep(0.5)
            continue
        try:
            requests.post(
                "%s/cam/frame?key=%s" % (base, key),
                data=jpeg,
                headers={"Content-Type": "image/jpeg"},
                timeout=4,
            )
        except Exception:
            time.sleep(0.3)


def hub_connect_socket():
    import base64 as _b64
    import os as _os

    cfg = hub_cfg()
    base = str(cfg.get("baseUrl") or "").rstrip("/")
    parsed = urlparse(base)
    host = parsed.hostname
    if not host:
        raise ConnectionError("hub baseUrl missing host")
    port = parsed.port or 80
    if parsed.scheme == "https":
        raise ConnectionError("hub uses a direct http IP")
    key = quote(str(cfg.get("key") or ""), safe="")
    path = "/ws?role=bridge&clientId=lan-bridge&key=%s" % key
    sock = socket.create_connection((host, port), timeout=8)
    nonce = _b64.b64encode(_os.urandom(16)).decode("ascii")
    req = (
        "GET %s HTTP/1.1\r\n"
        "Host: %s:%s\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Key: %s\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "\r\n"
    ) % (path, host, port, nonce)
    sock.sendall(req.encode("ascii"))
    buf = b""
    sock.settimeout(8)
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(1024)
        if not chunk:
            sock.close()
            raise ConnectionError("hub handshake closed")
        buf += chunk
        if len(buf) > 16384:
            sock.close()
            raise ConnectionError("hub handshake too long")
    status = buf.split(b"\r\n", 1)[0].decode("latin1", "replace")
    if " 101 " not in status:
        sock.close()
        raise ConnectionError(status[:180])
    return sock


def hub_bridge_loop():
    """Keep one WebSocket to the IP hub and mirror the local room both ways."""
    fail_delay = 2.0
    while True:
        if not hub_enabled():
            time.sleep(3)
            continue
        base = hub_base()
        sock = None
        try:
            print("[hub] connecting %s" % base, flush=True)
            sock = hub_connect_socket()
            with HUB_LOCK:
                HUB_STATE["sock"] = sock
            hub_mark(True, base=base)
            fail_delay = 2.0
            print("[hub] connected %s" % base, flush=True)
            hub_push_snapshot()
            while True:
                frame = ws_recv_message(sock, timeout=50)
                if frame is None:
                    try:
                        with HUB_SEND:
                            _ws_client_send(sock, 0x9, b"")
                    except Exception:
                        break
                    hub_mark(True, base=base)
                    continue
                opcode, payload = frame
                if opcode in (0x8, "close"):
                    break
                if opcode == 0x9:
                    try:
                        with HUB_SEND:
                            _ws_client_send(sock, 0xA, payload)
                    except Exception:
                        break
                    continue
                if opcode != 0x1:
                    continue
                try:
                    msg = json.loads(payload.decode("utf-8"))
                except Exception:
                    continue
                if not isinstance(msg, dict) or msg.get("channel") != CHANNEL:
                    continue
                kind = str(msg.get("type") or "")
                if kind == "cam-snap":
                    jpeg = camera_jpeg()
                    if jpeg:
                        threading.Thread(
                            target=hub_upload,
                            args=(jpeg, "photo", "image/jpeg"),
                            daemon=True,
                        ).start()
                    hub_mark(True, base=base)
                    continue
                if kind in ("ping", "heartbeat", "peers", "hub-ping"):
                    hub_mark(True, base=base)
                    continue
                msg["via"] = "hub"
                process_room_message(msg, str(msg.get("pin") or ""))
                hub_mark(True, base=base)
        except Exception as err:
            hub_mark(False, str(err), base=base)
            print("[hub] reconnect: %s" % err, flush=True)
        finally:
            with HUB_LOCK:
                if HUB_STATE.get("sock") is sock:
                    HUB_STATE["sock"] = None
                    HUB_STATE["ok"] = False
            if sock is not None:
                try:
                    sock.close()
                except Exception:
                    pass
        time.sleep(fail_delay)
        fail_delay = min(12.0, fail_delay + 1.0)


def room_broadcast(msg: dict, exclude_client: str | None = None, relay_ntfy: bool = True):
    raw_json = json.dumps(msg, ensure_ascii=False)
    sse_payload = "data: %s\n\n" % raw_json
    with ROOM_LOCK:
        sse_targets = list(ROOM_SSE)
        ws_targets = list(ROOM_WS)
    stale_sse = []
    for q in sse_targets:
        try:
            meta = getattr(q, "client_id", "")
            if exclude_client and meta == exclude_client:
                continue
            q.put_nowait(sse_payload)
        except Exception:
            stale_sse.append(q)
    if stale_sse:
        with ROOM_LOCK:
            for q in stale_sse:
                if q in ROOM_SSE:
                    ROOM_SSE.remove(q)
    stale_ws = []
    for entry in ws_targets:
        try:
            if exclude_client and entry.get("clientId") == exclude_client:
                continue
            if not entry.get("alive", True):
                stale_ws.append(entry)
                continue
            entry["send"](raw_json)
        except Exception:
            entry["alive"] = False
            stale_ws.append(entry)
    if stale_ws:
        with ROOM_LOCK:
            for entry in stale_ws:
                if entry in ROOM_WS:
                    ROOM_WS.remove(entry)
    if relay_ntfy:
        threading.Thread(target=hub_publish, args=(msg,), daemon=True).start()


def slim_state(state: dict) -> dict:
    slim = dict(state)
    if slim.get("bgImage") and str(slim["bgImage"]).startswith("data:"):
        slim["bgImage"] = ""
    return slim


def process_room_message(msg: dict, pin: str = "") -> dict:
    """Apply a room event from HTTP POST or WebSocket. Returns API-shaped result."""
    if not isinstance(msg, dict):
        return {"ok": False, "error": "bad payload", "status": 400}

    role = str(msg.get("from") or "")
    client_id = str(msg.get("clientId") or "")
    msg_type = str(msg.get("type") or "")
    touch_peer(client_id, role)

    needs_pin = role == "control" and msg_type in ("state", "cover")
    if needs_pin and not pin_ok(pin):
        return {"ok": False, "error": "admin pin required", "status": 401}

    if msg_type == "hello" and msg.get("pin") is not None:
        # Optional pin check on join for control clients.
        if role == "control" and not pin_ok(str(msg.get("pin") or pin or "")):
            return {"ok": False, "error": "admin pin required", "status": 401, "type": "auth"}

    if msg_type == "tick":
        return {"ok": True, "peers": peer_snapshot(), "status": 200}

    if msg_type == "state" and isinstance(msg.get("state"), dict):
        client_now = None
        if isinstance(msg["state"].get("updatedAt"), (int, float)):
            client_now = msg["state"].get("updatedAt")
        elif isinstance(msg.get("clientNow"), (int, float)):
            client_now = msg.get("clientNow")
        ok, state = apply_room_state(msg["state"], client_now)
        if ok:
            out = dict(msg)
            out.pop("pin", None)
            out.pop("clientNow", None)
            out["channel"] = CHANNEL
            out["state"] = slim_state(state)
            out["serverNow"] = state.get("serverNow")
            room_broadcast(out)
            if state.get("bgImage") and str(state["bgImage"]).startswith("data:"):
                room_broadcast(
                    {
                        "channel": CHANNEL,
                        "from": role or "server",
                        "clientId": client_id,
                        "type": "cover",
                        "bgId": state.get("bgId") or 0,
                        "bgImage": state.get("bgImage") or "",
                    },
                    exclude_client=client_id,
                )
        return {
            "ok": True,
            "accepted": ok,
            "revision": state.get("revision"),
            "peers": peer_snapshot(),
            "status": 200,
        }

    if msg_type == "cover":
        cover = apply_room_cover(msg.get("bgId"), msg.get("bgImage") or "")
        room_broadcast(
            {
                "channel": CHANNEL,
                "from": role or "server",
                "clientId": client_id,
                "type": "cover",
                "bgId": cover["bgId"],
                "bgImage": cover["bgImage"],
            },
            exclude_client=client_id,
        )
        return {"ok": True, "peers": peer_snapshot(), "status": 200}

    if msg_type in ("hello", "request"):
        live = snapshot_live()
        _state_ignored, cover = get_room_state()
        room_broadcast(
            {
                "channel": CHANNEL,
                "from": "server",
                "clientId": "server",
                "type": "state",
                "state": slim_state(live),
                "serverNow": live.get("serverNow"),
                "targetClientId": client_id,
            }
        )
        if cover.get("bgImage"):
            room_broadcast(
                {
                    "channel": CHANNEL,
                    "from": "server",
                    "clientId": "server",
                    "type": "cover",
                    "bgId": cover.get("bgId") or 0,
                    "bgImage": cover.get("bgImage") or "",
                    "targetClientId": client_id,
                }
            )
        room_broadcast(
            {
                "channel": CHANNEL,
                "from": role or "unknown",
                "clientId": client_id,
                "type": msg_type,
            },
            exclude_client=client_id,
        )
        room_broadcast(
            {
                "channel": CHANNEL,
                "from": "server",
                "clientId": "server",
                "type": "peers",
                "peers": peer_snapshot(),
            }
        )
        return {"ok": True, "peers": peer_snapshot(), "status": 200}

    out = dict(msg)
    out["channel"] = CHANNEL
    if client_id:
        out["clientId"] = client_id
    room_broadcast(out, exclude_client=client_id)
    if msg_type in ("ping", "heartbeat"):
        room_broadcast(
            {
                "channel": CHANNEL,
                "from": "server",
                "clientId": "server",
                "type": "peers",
                "peers": peer_snapshot(),
            }
        )
    return {"ok": True, "peers": peer_snapshot(), "status": 200}


def ws_accept_key(key: str) -> str:
    import base64
    import hashlib

    digest = hashlib.sha1((key + WS_MAGIC).encode("utf-8")).digest()
    return base64.b64encode(digest).decode("ascii")


def ws_send_text(sock, text: str) -> None:
    import struct

    data = text.encode("utf-8")
    n = len(data)
    header = bytearray([0x81])
    if n < 126:
        header.append(n)
    elif n < 65536:
        header.append(126)
        header.extend(struct.pack("!H", n))
    else:
        header.append(127)
        header.extend(struct.pack("!Q", n))
    sock.sendall(header + data)


def ws_recv_message(sock, timeout: float = 30.0):
    """Return (opcode, payload_bytes) or None on timeout/close."""
    import struct

    sock.settimeout(timeout)
    try:
        hdr = sock.recv(2)
    except (TimeoutError, socket.timeout, BlockingIOError, OSError):
        return None
    if not hdr or len(hdr) < 2:
        return ("close", b"")
    opcode = hdr[0] & 0x0F
    masked = (hdr[1] & 0x80) != 0
    length = hdr[1] & 0x7F
    if length == 126:
        ext = sock.recv(2)
        length = struct.unpack("!H", ext)[0]
    elif length == 127:
        ext = sock.recv(8)
        length = struct.unpack("!Q", ext)[0]
    mask = sock.recv(4) if masked else b""
    data = bytearray()
    while len(data) < length:
        chunk = sock.recv(length - len(data))
        if not chunk:
            return ("close", b"")
        data.extend(chunk)
    if masked:
        data = bytearray(b ^ mask[i % 4] for i, b in enumerate(data))
    return (opcode, bytes(data))


def get_room_state():
    with ROOM_LOCK:
        state = dict(ROOM_STATE) if ROOM_STATE else default_room_state()
        cover = dict(ROOM_COVER)
    return state, cover


def server_now_ms() -> int:
    return int(time.time() * 1000)


def refresh_remaining(state: dict, now: int | None = None, bump_on_end: bool = False) -> dict:
    """Recompute remainingMs from endsAt on the server clock."""
    now = server_now_ms() if now is None else int(now)
    state = dict(state)
    if state.get("status") == "running" and isinstance(state.get("endsAt"), (int, float)):
        per = float(state.get("msPerTick") or 1000) or 1000.0
        if per <= 0:
            per = 1000.0
        rem = ((float(state["endsAt"]) - now) / per) * 1000.0
        if rem <= 0:
            state["status"] = "ended"
            state["remainingMs"] = 0
            state["endsAt"] = None
            if bump_on_end:
                state["revision"] = int(state.get("revision") or 0) + 1
        else:
            state["remainingMs"] = rem
    state["serverNow"] = now
    return state


def adopt_client_clock(state: dict, client_now) -> dict:
    """Shift a client-computed endsAt onto the server clock, then refresh remaining."""
    state = dict(state)
    now = server_now_ms()
    if (
        state.get("status") == "running"
        and isinstance(state.get("endsAt"), (int, float))
        and isinstance(client_now, (int, float))
        and float(client_now) > 0
    ):
        state["endsAt"] = float(state["endsAt"]) + (now - float(client_now))
    return refresh_remaining(state, now, bump_on_end=True)


def snapshot_live() -> dict:
    """Current room state on the server clock. Persists a running→ended transition."""
    global ROOM_STATE
    with ROOM_LOCK:
        cur = dict(ROOM_STATE or default_room_state())
        prev_status = cur.get("status")
        prev_rev = int(cur.get("revision") or 0)
        live = refresh_remaining(cur, bump_on_end=True)
        if (
            ROOM_STATE is not None
            and int(ROOM_STATE.get("revision") or 0) == prev_rev
            and ROOM_STATE.get("status") == prev_status
        ):
            ROOM_STATE["remainingMs"] = live.get("remainingMs")
            ROOM_STATE["endsAt"] = live.get("endsAt")
            ROOM_STATE["status"] = live.get("status")
            ROOM_STATE["serverNow"] = live.get("serverNow")
            ROOM_STATE["revision"] = live.get("revision")
            live = dict(ROOM_STATE)
        return live


def apply_room_state(incoming: dict, client_now=None):
    global ROOM_STATE
    if not isinstance(incoming, dict):
        return False, get_room_state()[0]
    rev = incoming.get("revision")
    if not isinstance(rev, (int, float)):
        return False, get_room_state()[0]
    with ROOM_LOCK:
        cur = ROOM_STATE or default_room_state()
        if float(rev) < float(cur.get("revision") or 0):
            return False, dict(cur)
        merged = dict(default_room_state())
        merged.update(incoming)
        # Keep server cover if slim packet stripped data-URL.
        if not merged.get("bgImage") and ROOM_COVER.get("bgImage"):
            if int(merged.get("bgId") or 0) == int(ROOM_COVER.get("bgId") or 0):
                merged["bgImage"] = ROOM_COVER.get("bgImage") or ""
        if isinstance(incoming.get("serverNow"), (int, float)):
            merged = refresh_remaining(merged, bump_on_end=True)
        else:
            if not isinstance(client_now, (int, float)):
                client_now = incoming.get("updatedAt")
            merged = adopt_client_clock(merged, client_now)
        ROOM_STATE = merged
        if merged.get("bgImage"):
            ROOM_COVER["bgId"] = int(merged.get("bgId") or 0)
            ROOM_COVER["bgImage"] = merged.get("bgImage") or ""
        return True, dict(ROOM_STATE)


def apply_room_cover(bg_id, bg_image: str):
    global ROOM_COVER, ROOM_STATE
    with ROOM_LOCK:
        ROOM_COVER = {"bgId": int(bg_id or 0), "bgImage": bg_image or ""}
        if ROOM_STATE is not None:
            ROOM_STATE["bgId"] = ROOM_COVER["bgId"]
            ROOM_STATE["bgImage"] = ROOM_COVER["bgImage"]
        return dict(ROOM_COVER)


def pin_ok(provided: str) -> bool:
    cfg = load_room()
    expected = str(cfg.get("adminPin") or "")
    if not expected:
        return True
    return (provided or "") == expected


def load_camera():
    path = ROOT / "camera.json"
    if not path.exists():
        return dict(CAM_CFG)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return dict(CAM_CFG)
    out = dict(CAM_CFG)
    out.update({k: data[k] for k in out if k in data})
    return out


def rtsp_url(cam=None):
    cam = cam or load_camera()
    subtype = int(cam.get("subtype", 0))
    if str(cam.get("stream", "main")).lower() == "main":
        subtype = 0
    elif str(cam.get("stream", "")).lower() == "sub":
        subtype = 1
    return (
        "rtsp://%s:%s@%s:554/cam/realmonitor?channel=%s&subtype=%s"
        % (cam["user"], cam["password"], cam["host"], cam["channel"], subtype)
    )


def prep_speak(text: str) -> str:
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"فرخ[\u200c\s\-]*خان", "فَرُّخ خان", text)
    text = re.sub(r"\n+", ". ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def synthesize(text: str, out_path: Path) -> None:
    spoken = prep_speak(text)
    if not spoken:
        raise ValueError("empty text")

    async def run():
        communicate = edge_tts.Communicate(spoken, VOICE)
        await communicate.save(str(out_path))

    asyncio.run(run())


def list_captures(limit: int = 24):
    CAP_DIR.mkdir(exist_ok=True)
    files = []
    for path in CAP_DIR.iterdir():
        if not path.is_file():
            continue
        if path.suffix.lower() not in (".jpg", ".jpeg", ".png", ".webm", ".mp4"):
            continue
        files.append(path)
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    out = []
    for path in files[:limit]:
        out.append(
            {
                "name": path.name,
                "url": "/_captures/%s" % path.name,
                "kind": "video" if path.suffix.lower() in (".webm", ".mp4") else "image",
                "mtime": int(path.stat().st_mtime),
                "size": path.stat().st_size,
            }
        )
    return out


def safe_capture_name(name: str, fallback_ext: str) -> str:
    base = re.sub(r"[^A-Za-z0-9_\-\.]", "", name or "")
    if not base or base.startswith("."):
        stamp = time.strftime("%Y%m%d-%H%M%S")
        base = "capture-%s-%s%s" % (stamp, uuid.uuid4().hex[:6], fallback_ext)
    if "." not in base:
        base += fallback_ext
    return base


def _graceful_stop_ffmpeg(proc, timeout=8):
    if proc.poll() is not None:
        return True
    try:
        if proc.stdin:
            proc.stdin.write(b"q")
            proc.stdin.flush()
    except Exception:
        pass
    try:
        proc.wait(timeout=timeout)
        return True
    except subprocess.TimeoutExpired:
        pass
    try:
        proc.terminate()
        proc.wait(timeout=3)
        return True
    except Exception:
        pass
    try:
        proc.kill()
        proc.wait(timeout=2)
    except Exception:
        pass
    return proc.poll() is not None


def _remux_to_mp4(src: Path) -> Path | None:
    if not src.exists() or src.stat().st_size < 1024:
        return None
    dst = src.with_suffix(".mp4")
    if dst.exists():
        try:
            dst.unlink()
        except Exception:
            pass
    cmd = [
        FFMPEG,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(src),
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        str(dst),
    ]
    try:
        done = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=60)
    except Exception:
        return None
    if done.returncode != 0 or not dst.exists() or dst.stat().st_size < 1024:
        return None
    try:
        src.unlink()
    except Exception:
        pass
    return dst


def stop_recording():
    global REC_PROC, REC_PATH
    with REC_LOCK:
        proc = REC_PROC
        path = REC_PATH
        REC_PROC = None
        REC_PATH = None
    if not proc:
        return None
    _graceful_stop_ffmpeg(proc)
    if not path or not path.exists() or path.stat().st_size < 1024:
        return {"ok": False, "error": "empty or missing recording"}
    final = path
    if path.suffix.lower() in (".mkv", ".ts"):
        remuxed = _remux_to_mp4(path)
        if remuxed is None:
            # MKV/TS itself is still playable if remux fails.
            final = path
        else:
            final = remuxed
    return {
        "ok": True,
        "name": final.name,
        "url": "/_captures/%s" % final.name,
        "kind": "video",
        "size": final.stat().st_size,
    }


def start_recording():
    global REC_PROC, REC_PATH
    if not Path(FFMPEG).exists():
        return {"ok": False, "error": "ffmpeg not found"}
    stop_recording()
    CAP_DIR.mkdir(exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    # MKV tolerates mid-stream stop; we remux to MP4 on stop.
    name = "rec-%s-%s.mkv" % (stamp, uuid.uuid4().hex[:6])
    out = CAP_DIR / name
    cam = load_camera()
    cmd = [
        FFMPEG,
        "-hide_banner",
        "-loglevel",
        "error",
        "-rtsp_transport",
        "tcp",
        "-i",
        rtsp_url(cam),
        "-c",
        "copy",
        "-y",
        str(out),
    ]
    try:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception as err:
        return {"ok": False, "error": str(err)}
    with REC_LOCK:
        REC_PROC = proc
        REC_PATH = out
    return {"ok": True, "name": name, "url": "/_captures/%s" % name, "kind": "video"}


class Handler(BaseHTTPRequestHandler):
    server_version = "BlackroomServe/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.log_date_time_string(), fmt % args), flush=True)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Filename, X-Admin-Pin")
        self.send_header("Cache-Control", "no-store")

    def _json(self, code: int, payload):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        if path in ("/ws", "/api/room/ws"):
            self._websocket(parsed)
            return

        if path in ("/api/cam.mjpg", "/api/cam.jpg"):
            self._cam(path.endswith(".jpg"))
            return

        if path == "/api/cam/captures":
            self._json(200, {"items": list_captures()})
            return

        if path == "/api/cam/rec/status":
            with REC_LOCK:
                active = bool(REC_PROC and REC_PROC.poll() is None)
                name = REC_PATH.name if REC_PATH else ""
            self._json(200, {"recording": active, "name": name, "stream": load_camera().get("stream", "main")})
            return

        if path.startswith("/api/tts/") and path.endswith(".mp3"):
            name = path.rsplit("/", 1)[-1]
            if not re.fullmatch(r"[A-Za-z0-9_\-]+\.mp3", name):
                self.send_error(400, "bad id")
                return
            file_path = TTS_DIR / name
            if not file_path.exists():
                self.send_error(404, "missing")
                return
            data = file_path.read_bytes()
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        if path == "/api/health":
            cam = load_camera()
            cfg = load_room()
            peers = peer_snapshot()
            self._json(
                200,
                {
                    "ok": True,
                    "camera": cam["host"],
                    "stream": cam.get("stream", "main"),
                    "subtype": int(cam.get("subtype", 0)),
                    "tts": True,
                    "captures": True,
                    "ffmpeg": Path(FFMPEG).exists(),
                    "room": cfg.get("roomName") or "BLACKROOM",
                    "pinRequired": bool(cfg.get("adminPin")),
                    "peers": peers,
                },
            )
            return

        if path == "/api/room/state":
            live = snapshot_live()
            _state_ignored, cover = get_room_state()
            slim = slim_state(live)
            self._json(
                200,
                {
                    "ok": True,
                    "state": slim,
                    "serverNow": live.get("serverNow"),
                    "cover": cover,
                    "peers": peer_snapshot(),
                },
            )
            return

        if path == "/api/room/peers":
            self._json(200, peer_snapshot())
            return

        if path == "/api/room/info":
            cfg = load_room()
            hub = dict(cfg.get("hub") or {})
            self._json(
                200,
                {
                    "ok": True,
                    "room": cfg.get("roomName") or "BLACKROOM",
                    "pinRequired": bool(cfg.get("adminPin")),
                    "port": int(cfg.get("port") or PORT),
                    "bind": cfg.get("bind") or BIND,
                    "wsPath": "/ws",
                    "publicUrl": cfg.get("publicUrl") or "",
                    "hub": {
                        "enabled": bool(hub.get("enabled")),
                        "baseUrl": str(hub.get("baseUrl") or "http://5.57.39.218:6985").rstrip("/"),
                        "key": hub.get("key") or "",
                        "status": hub_snapshot(),
                    },
                    "lan": lan_addrs(),
                    "peers": peer_snapshot(),
                },
            )
            return

        if path == "/api/room/events":
            self._sse(parsed)
            return

        if path in ("/api/remote-control", "/remote-control.html"):
            self._remote_control(parsed)
            return

        self._static(path)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""

        if path == "/api/room/auth":
            try:
                body = json.loads(raw.decode("utf-8") if raw else "{}")
            except Exception:
                self.send_error(400, "bad json")
                return
            pin = ""
            if isinstance(body, dict):
                pin = str(body.get("pin") or "")
            if not pin_ok(pin):
                self._json(401, {"ok": False, "error": "bad pin"})
                return
            self._json(200, {"ok": True, "room": load_room().get("roomName") or "BLACKROOM"})
            return

        if path == "/api/room/publish":
            self._room_publish(raw)
            return

        if path == "/api/tts":
            try:
                body = json.loads(raw.decode("utf-8") if raw else "{}")
            except Exception:
                self.send_error(400, "bad json")
                return
            text = body.get("text") if isinstance(body, dict) else ""
            if not isinstance(text, str) or not text.strip():
                self.send_error(400, "text required")
                return
            TTS_DIR.mkdir(exist_ok=True)
            name = "say-%s.mp3" % uuid.uuid4().hex[:12]
            out = TTS_DIR / name
            try:
                synthesize(text, out)
            except Exception as err:
                self.send_error(500, "tts failed: %s" % err)
                return
            self._json(200, {"url": "/api/tts/%s" % name})
            return

        if path == "/api/cam/snap":
            cam = load_camera()
            auth = HTTPDigestAuth(cam["user"], cam["password"])
            url = "http://%s/cgi-bin/snapshot.cgi" % cam["host"]
            try:
                upstream = requests.get(url, auth=auth, timeout=(3, 20))
            except Exception as err:
                self._json(502, {"ok": False, "error": str(err)})
                return
            if upstream.status_code != 200 or not upstream.content:
                self._json(upstream.status_code, {"ok": False, "error": "snapshot failed"})
                return
            CAP_DIR.mkdir(exist_ok=True)
            stamp = time.strftime("%Y%m%d-%H%M%S")
            name = "snap-%s-%s.jpg" % (stamp, uuid.uuid4().hex[:6])
            out = CAP_DIR / name
            out.write_bytes(upstream.content)
            snap_bytes = upstream.content
            threading.Thread(
                target=hub_upload,
                args=(snap_bytes, "photo", "image/jpeg"),
                daemon=True,
            ).start()
            self._json(
                200,
                {
                    "ok": True,
                    "name": name,
                    "url": "/_captures/%s" % name,
                    "kind": "image",
                    "size": len(upstream.content),
                },
            )
            return

        if path == "/api/cam/rec/start":
            result = start_recording()
            self._json(200 if result.get("ok") else 500, result)
            return

        if path == "/api/cam/rec/stop":
            result = stop_recording() or {"ok": False, "error": "not recording"}
            self._json(200 if result.get("ok") else 400, result)
            return

        if path == "/api/cam/save":
            ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if ctype not in ("image/jpeg", "image/png", "video/webm", "video/mp4", "application/octet-stream"):
                self.send_error(400, "unsupported type")
                return
            ext = {
                "image/jpeg": ".jpg",
                "image/png": ".png",
                "video/webm": ".webm",
                "video/mp4": ".mp4",
                "application/octet-stream": ".bin",
            }.get(ctype, ".bin")
            suggested = self.headers.get("X-Filename") or ""
            name = safe_capture_name(suggested, ext)
            CAP_DIR.mkdir(exist_ok=True)
            out = CAP_DIR / name
            out.write_bytes(raw)
            kind = "video" if ext in (".webm", ".mp4") else "image"
            self._json(
                200,
                {
                    "ok": True,
                    "name": name,
                    "url": "/_captures/%s" % name,
                    "kind": kind,
                    "size": len(raw),
                },
            )
            return

        self.send_error(404)

    def _room_publish(self, raw: bytes):
        try:
            msg = json.loads(raw.decode("utf-8") if raw else "{}")
        except Exception:
            self.send_error(400, "bad json")
            return
        pin = self.headers.get("X-Admin-Pin") or ""
        result = process_room_message(msg, pin)
        status = int(result.pop("status", 200) or 200)
        self._json(status, result)

    def _websocket(self, parsed):
        key = self.headers.get("Sec-WebSocket-Key")
        if not key:
            self.send_error(400, "missing websocket key")
            return
        qs = parse_qs(parsed.query or "")
        role = (qs.get("role") or ["unknown"])[0]
        client_id = (qs.get("clientId") or [""])[0] or ("ws-" + uuid.uuid4().hex[:8])
        pin = (qs.get("pin") or [""])[0] or (self.headers.get("X-Admin-Pin") or "")

        if role == "control" and load_room().get("adminPin") and not pin_ok(pin):
            # Allow connect; auth enforced on state/cover. Still send auth hint.
            pass

        accept = ws_accept_key(key)
        self.close_connection = True
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        try:
            self.wfile.flush()
        except Exception:
            pass

        sock = self.connection
        entry = {
            "clientId": client_id,
            "role": role,
            "alive": True,
            "send": lambda text, s=sock: ws_send_text(s, text),
        }
        with ROOM_LOCK:
            ROOM_WS.append(entry)
        touch_peer(client_id, role)

        # Snapshot on connect.
        try:
            state, cover = get_room_state()
            ws_send_text(
                sock,
                json.dumps(
                    {
                        "channel": CHANNEL,
                        "from": "server",
                        "clientId": "server",
                        "type": "state",
                        "state": slim_state(state),
                    },
                    ensure_ascii=False,
                ),
            )
            if cover.get("bgImage"):
                ws_send_text(
                    sock,
                    json.dumps(
                        {
                            "channel": CHANNEL,
                            "from": "server",
                            "clientId": "server",
                            "type": "cover",
                            "bgId": cover.get("bgId") or 0,
                            "bgImage": cover.get("bgImage") or "",
                        },
                        ensure_ascii=False,
                    ),
                )
            ws_send_text(
                sock,
                json.dumps(
                    {
                        "channel": CHANNEL,
                        "from": "server",
                        "clientId": "server",
                        "type": "peers",
                        "peers": peer_snapshot(),
                    },
                    ensure_ascii=False,
                ),
            )
            ws_send_text(
                sock,
                json.dumps(
                    {
                        "channel": CHANNEL,
                        "from": "server",
                        "clientId": "server",
                        "type": "ready",
                        "ws": True,
                        "pinRequired": bool(load_room().get("adminPin")),
                    },
                    ensure_ascii=False,
                ),
            )
        except Exception:
            entry["alive"] = False

        try:
            while entry.get("alive", True):
                got = ws_recv_message(sock, timeout=25.0)
                if got is None:
                    # keepalive ping
                    try:
                        sock.sendall(bytearray([0x89, 0x00]))  # ping
                        touch_peer(client_id, role)
                    except Exception:
                        break
                    continue
                opcode, payload = got
                if opcode == "close" or opcode == 0x8:
                    break
                if opcode == 0x9:  # ping
                    try:
                        sock.sendall(bytearray([0x8A]) + bytes([len(payload)]) + payload)
                    except Exception:
                        break
                    continue
                if opcode == 0xA:  # pong
                    touch_peer(client_id, role)
                    continue
                if opcode != 0x1:
                    continue
                try:
                    msg = json.loads(payload.decode("utf-8"))
                except Exception:
                    continue
                if isinstance(msg, dict) and not msg.get("clientId"):
                    msg["clientId"] = client_id
                if isinstance(msg, dict) and not msg.get("from"):
                    msg["from"] = role
                result = process_room_message(msg, pin if pin else str((msg or {}).get("pin") or ""))
                if result.get("status") == 401:
                    try:
                        ws_send_text(
                            sock,
                            json.dumps(
                                {
                                    "channel": CHANNEL,
                                    "from": "server",
                                    "clientId": "server",
                                    "type": "auth",
                                    "ok": False,
                                    "error": result.get("error") or "pin",
                                },
                                ensure_ascii=False,
                            ),
                        )
                    except Exception:
                        break
                touch_peer(client_id, role)
        finally:
            entry["alive"] = False
            with ROOM_LOCK:
                if entry in ROOM_WS:
                    ROOM_WS.remove(entry)
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except Exception:
                pass

    def _sse(self, parsed):
        qs = parse_qs(parsed.query or "")
        role = (qs.get("role") or ["unknown"])[0]
        client_id = (qs.get("clientId") or [""])[0] or ("anon-" + uuid.uuid4().hex[:8])
        touch_peer(client_id, role)

        q = queue.Queue(maxsize=64)
        q.client_id = client_id  # type: ignore[attr-defined]
        with ROOM_LOCK:
            ROOM_SSE.append(q)

        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        # Snapshot on connect.
        state, cover = get_room_state()
        slim = dict(state)
        if slim.get("bgImage") and str(slim["bgImage"]).startswith("data:"):
            slim["bgImage"] = ""
        hello = {
            "channel": CHANNEL,
            "from": "server",
            "clientId": "server",
            "type": "state",
            "state": slim,
        }
        try:
            self.wfile.write(("data: %s\n\n" % json.dumps(hello, ensure_ascii=False)).encode("utf-8"))
            if cover.get("bgImage"):
                cov = {
                    "channel": CHANNEL,
                    "from": "server",
                    "clientId": "server",
                    "type": "cover",
                    "bgId": cover.get("bgId") or 0,
                    "bgImage": cover.get("bgImage") or "",
                }
                self.wfile.write(("data: %s\n\n" % json.dumps(cov, ensure_ascii=False)).encode("utf-8"))
            peers_msg = {
                "channel": CHANNEL,
                "from": "server",
                "clientId": "server",
                "type": "peers",
                "peers": peer_snapshot(),
            }
            self.wfile.write(("data: %s\n\n" % json.dumps(peers_msg, ensure_ascii=False)).encode("utf-8"))
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            with ROOM_LOCK:
                if q in ROOM_SSE:
                    ROOM_SSE.remove(q)
            return

        try:
            while True:
                try:
                    chunk = q.get(timeout=15)
                except queue.Empty:
                    touch_peer(client_id, role)
                    try:
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        break
                    continue
                try:
                    self.wfile.write(chunk.encode("utf-8") if isinstance(chunk, str) else chunk)
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    break
                touch_peer(client_id, role)
        finally:
            with ROOM_LOCK:
                if q in ROOM_SSE:
                    ROOM_SSE.remove(q)

    def _remote_control(self, parsed):
        qs = parse_qs(parsed.query or "")
        as_download = (qs.get("download") or ["0"])[0] in ("1", "true", "yes")
        template = ROOT / "remote-control.html"
        if not template.is_file():
            self.send_error(404, "remote-control.html missing")
            return
        html = template.read_text(encoding="utf-8")
        cfg = load_room()
        hub = dict(cfg.get("hub") or {})
        live = snapshot_live()
        boot = {
            "baseUrl": str(hub.get("baseUrl") or "http://5.57.39.218:6985").rstrip("/"),
            "key": hub.get("key") or "",
            "pin": cfg.get("adminPin") or "",
            "room": cfg.get("roomName") or "BLACKROOM",
            "serverNow": live.get("serverNow"),
            "state": slim_state(live),
        }
        boot_js = "<script>window.REMOTE_BOOT = %s;</script>" % json.dumps(boot, ensure_ascii=False)
        if "window.REMOTE_BOOT" in html:
            html = html.replace(
                "window.REMOTE_BOOT = window.REMOTE_BOOT || null;",
                "window.REMOTE_BOOT = window.REMOTE_BOOT || %s;" % json.dumps(boot, ensure_ascii=False),
                1,
            )
        else:
            html = html.replace("</head>", boot_js + "\n</head>", 1)
        data = html.encode("utf-8")
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "text/html; charset=utf-8")
        if as_download:
            self.send_header(
                "Content-Disposition",
                'attachment; filename="blackroom-remote-control.html"',
            )
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _static(self, path: str):
        if path == "/":
            path = "/index.html"
        rel = path.lstrip("/").replace("\\", "/")
        if ".." in rel.split("/"):
            self.send_error(400)
            return
        file_path = (ROOT / rel).resolve()
        if not str(file_path).startswith(str(ROOT)) or not file_path.is_file():
            self.send_error(404)
            return
        data = file_path.read_bytes()
        ctype = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _cam(self, still: bool):
        cam = load_camera()
        if still:
            auth = HTTPDigestAuth(cam["user"], cam["password"])
            url = "http://%s/cgi-bin/snapshot.cgi" % cam["host"]
            try:
                upstream = requests.get(url, auth=auth, stream=True, timeout=(3, 20))
            except Exception as err:
                self.send_error(502, "camera unreachable: %s" % err)
                return
            if upstream.status_code != 200:
                self.send_error(upstream.status_code, "camera auth/stream failed")
                upstream.close()
                return
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", upstream.headers.get("Content-Type") or "image/jpeg")
            self.end_headers()
            try:
                for chunk in upstream.iter_content(chunk_size=16 * 1024):
                    if not chunk:
                        continue
                    self.wfile.write(chunk)
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                upstream.close()
            return

        stream = str(cam.get("stream", "main")).lower()
        if stream == "sub" or not Path(FFMPEG).exists():
            self._cam_sub_mjpg(cam)
            return
        self._cam_main_mjpg(cam)

    def _cam_sub_mjpg(self, cam):
        auth = HTTPDigestAuth(cam["user"], cam["password"])
        url = (
            "http://%s/cgi-bin/mjpg/video.cgi?channel=%s&subtype=1"
            % (cam["host"], cam["channel"])
        )
        try:
            upstream = requests.get(url, auth=auth, stream=True, timeout=(3, 60))
        except Exception as err:
            self.send_error(502, "camera unreachable: %s" % err)
            return
        if upstream.status_code != 200:
            self.send_error(upstream.status_code, "camera auth/stream failed")
            upstream.close()
            return
        self.send_response(200)
        self._cors()
        self.send_header(
            "Content-Type",
            upstream.headers.get("Content-Type")
            or "multipart/x-mixed-replace; boundary=myboundary",
        )
        self.end_headers()
        try:
            for chunk in upstream.iter_content(chunk_size=16 * 1024):
                if not chunk:
                    continue
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            upstream.close()

    def _cam_main_mjpg(self, cam):
        # Main stream is H.264 1080p; re-encode to MJPEG for browser <img> preview.
        scale = int(cam.get("previewScale") or 0)
        vf = []
        if scale > 0:
            vf.extend(["-vf", "scale=%d:-1" % scale])
        cmd = [
            FFMPEG,
            "-hide_banner",
            "-loglevel",
            "error",
            "-rtsp_transport",
            "tcp",
            "-i",
            rtsp_url(cam),
            "-an",
            *vf,
            "-q:v",
            "3",
            "-r",
            "15",
            "-f",
            "mpjpeg",
            "pipe:1",
        ]
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
        except Exception as err:
            self.send_error(500, "ffmpeg failed: %s" % err)
            return
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=ffmpeg")
        self.end_headers()
        try:
            while True:
                chunk = proc.stdout.read(16 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            try:
                if proc.poll() is None:
                    proc.kill()
            except Exception:
                pass
            try:
                proc.wait(timeout=2)
            except Exception:
                pass


def main():
    global PORT, BIND, ROOM_STATE
    TTS_DIR.mkdir(exist_ok=True)
    CAP_DIR.mkdir(exist_ok=True)
    cfg = load_room()
    PORT = int(cfg.get("port") or PORT)
    BIND = str(cfg.get("bind") or BIND)
    ROOM_STATE = default_room_state()
    cam = load_camera()
    threading.Thread(target=room_clock_loop, name="room-clock", daemon=True).start()
    if hub_enabled():
        threading.Thread(target=hub_bridge_loop, name="hub-bridge", daemon=True).start()
        threading.Thread(target=hub_cam_loop, name="hub-cam", daemon=True).start()
    httpd = ThreadingHTTPServer((BIND, PORT), Handler)
    print("BLACKROOM server  http://127.0.0.1:%s/" % PORT, flush=True)
    for ip in lan_addrs():
        print("LAN               http://%s:%s/" % (ip, PORT), flush=True)
    print("Display (source)  /display.html", flush=True)
    print("Control (admin)   /control.html", flush=True)
    print("WebSocket sync    ws://<ip>:%s/ws" % PORT, flush=True)
    print("Room hub          /ws  +  POST /api/room/publish", flush=True)
    hcfg = cfg.get("hub") or {}
    if hcfg.get("enabled"):
        print(
            "sync hub          %s" % str(hcfg.get("baseUrl") or "").rstrip("/"),
            flush=True,
        )
    print("Admin PIN         %s" % ("set" if cfg.get("adminPin") else "disabled"), flush=True)
    if cfg.get("publicUrl"):
        print("Public URL        %s" % cfg.get("publicUrl"), flush=True)
    print(
        "Camera main       RTSP subtype=0 1080p via ffmpeg -> /api/cam.mjpg",
        flush=True,
    )
    print("Camera host       %s  stream=%s" % (cam["host"], cam.get("stream", "main")), flush=True)
    print("Captures          /_captures/", flush=True)
    print("TTS               POST /api/tts", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye", flush=True)
    finally:
        stop_recording()
        httpd.server_close()


if __name__ == "__main__":
    main()
