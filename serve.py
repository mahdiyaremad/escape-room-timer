#!/usr/bin/env python3
"""Local BLACKROOM server: static files + Persian TTS + Dahua camera proxy."""

from __future__ import annotations

import asyncio
import json
import mimetypes
import re
import shutil
import subprocess
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

import edge_tts
import requests
from requests.auth import HTTPDigestAuth

ROOT = Path(__file__).resolve().parent
TTS_DIR = ROOT / "_tts_cache"
CAP_DIR = ROOT / "_captures"
PORT = 8765
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

REC_PROC = None
REC_PATH = None
REC_LOCK = __import__("threading").Lock()


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

    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.log_date_time_string(), fmt % args), flush=True)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Filename")
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
                },
            )
            return

        self._static(path)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""

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
    TTS_DIR.mkdir(exist_ok=True)
    CAP_DIR.mkdir(exist_ok=True)
    cam = load_camera()
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("BLACKROOM server  http://127.0.0.1:%s/" % PORT, flush=True)
    print(
        "Camera main       RTSP subtype=0 1080p via ffmpeg -> /api/cam.mjpg",
        flush=True,
    )
    print("Camera host       %s  stream=%s" % (cam["host"], cam.get("stream", "main")), flush=True)
    print("Captures          http://127.0.0.1:%s/_captures/" % PORT, flush=True)
    print("TTS               POST http://127.0.0.1:%s/api/tts" % PORT, flush=True)
    print("Open              http://127.0.0.1:%s/index.html" % PORT, flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye", flush=True)
    finally:
        stop_recording()
        httpd.server_close()


if __name__ == "__main__":
    main()
