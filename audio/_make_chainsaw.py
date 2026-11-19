#!/usr/bin/env python3
"""Synthesize a start-to-stop chainsaw one-shot into audio/chainsaw.mp3."""

from __future__ import annotations

import math
import struct
import subprocess
import wave
from pathlib import Path

SR = 44100
ROOT = Path(__file__).resolve().parent
WAV = ROOT / "_chainsaw_build" / "full.wav"
MP3 = ROOT / "chainsaw.mp3"
FFMPEG = (
    __import__("shutil").which("ffmpeg")
    or r"C:\Users\Mahdiyar\AppData\Local\Microsoft\WinGet\Links\ffmpeg.exe"
)


def clamp(x: float) -> float:
    return max(-1.0, min(1.0, x))


def fade(i: int, n: int, ain: float, aout: float) -> float:
    t = i / SR
    dur = n / SR
    g = 1.0
    if ain > 0 and t < ain:
        g *= t / ain
    if aout > 0 and t > dur - aout:
        g *= max(0.0, (dur - t) / aout)
    return g


def noise(i: int, seed: int = 0) -> float:
    x = math.sin(i * 12.9898 + seed * 78.233) * 43758.5453
    return (x - math.floor(x)) * 2.0 - 1.0


def engine(t: float, rpm_hz: float, load: float = 1.0) -> float:
    ign = 0.55 + 0.45 * (0.5 + 0.5 * math.sin(2 * math.pi * rpm_hz * t))
    phase = 2 * math.pi * rpm_hz * t
    saw = 0.0
    for h, amp in ((1, 1.0), (2, 0.55), (3, 0.35), (4, 0.22), (5, 0.14), (6, 0.09), (8, 0.05)):
        saw += amp * math.sin(phase * h + (0.15 if h % 2 else 0.0))
    saw /= 2.2
    tone = math.tanh(saw * (1.6 + 0.8 * load))
    grit = noise(int(t * SR), 3) * 0.22 * load
    grit += noise(int(t * SR), 9) * 0.10
    return (tone * 0.78 + grit) * ign


def main() -> None:
    samples: list[float] = []

    def add_seconds(dur: float, fn, ain: float = 0.02, aout: float = 0.02) -> None:
        n = int(dur * SR)
        for i in range(n):
            t = i / SR
            samples.append(clamp(fn(t, i) * fade(i, n, ain, aout)))

    def pull(t: float, i: int) -> float:
        scrape = noise(i, 1) * (0.35 + 0.65 * abs(math.sin(2 * math.pi * 7 * t)))
        scrape *= math.exp(-2.2 * t)
        click = 0.0
        if 0.42 < t < 0.50:
            click = noise(i, 5) * math.exp(-(t - 0.42) * 40) * 0.9
        return scrape * 0.9 + click

    add_seconds(0.55, pull, 0.01, 0.05)

    def catch(t: float, i: int) -> float:
        bursts = 0.0
        for center, w in ((0.08, 0.05), (0.18, 0.06), (0.30, 0.07)):
            if abs(t - center) < w:
                local = (t - (center - w)) / (2 * w)
                rpm = 28 + 40 * local
                bursts += engine(t, rpm, 0.7) * (1 - abs(t - center) / w)
        return bursts * 0.85

    add_seconds(0.38, catch, 0.0, 0.02)

    def revup(t: float, i: int) -> float:
        u = t / 1.7
        rpm = 38 + 62 * (u ** 0.7)
        load = 0.7 + 0.5 * u
        rpm += 3 * math.sin(2 * math.pi * 2.5 * t)
        return engine(t, rpm, load) * (0.55 + 0.45 * u)

    add_seconds(1.7, revup, 0.0, 0.02)

    def running(t: float, i: int) -> float:
        rpm = 78.0
        load = 0.95
        if 1.2 <= t <= 2.0:
            u = (t - 1.2) / 0.8
            bump = math.sin(math.pi * u)
            rpm = 78 + 45 * bump
            load = 0.95 + 0.45 * bump
        if 3.1 <= t <= 4.0:
            u = (t - 3.1) / 0.9
            bump = math.sin(math.pi * u)
            rpm = 78 + 55 * bump
            load = 0.95 + 0.55 * bump
        rpm += 1.8 * math.sin(2 * math.pi * 1.7 * t)
        return engine(t, rpm, load)

    add_seconds(5.0, running, 0.02, 0.02)

    def winddown(t: float, i: int) -> float:
        u = t / 2.4
        rpm = 85 * (1 - u) ** 1.15 + 8
        load = max(0.0, 1.0 - u * 1.05)
        sig = engine(t, max(6.0, rpm), load) * (1 - u) ** 0.6
        if t > 1.7:
            chug = math.exp(-(t - 1.7) * 3.5) * engine(t, 18 + 10 * math.sin(20 * t), 0.4)
            sig = sig * 0.4 + chug * 0.8
        if t > 2.15:
            sig *= math.exp(-(t - 2.15) * 18)
        return sig

    add_seconds(2.4, winddown, 0.0, 0.15)

    peak = max(abs(x) for x in samples) or 1.0
    gain = 0.92 / peak
    pcm = bytearray()
    for x in samples:
        v = int(clamp(x * gain) * 32767)
        pcm += struct.pack("<h", v)

    WAV.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(WAV), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm)

    subprocess.check_call(
        [
            FFMPEG,
            "-y",
            "-i",
            str(WAV),
            "-af",
            "highpass=f=60,lowpass=f=6500,equalizer=f=850:t=q:w=1.1:g=5,equalizer=f=160:t=q:w=1:g=3,loudnorm=I=-12:TP=-1.2:LRA=10",
            "-codec:a",
            "libmp3lame",
            "-b:a",
            "192k",
            str(MP3),
        ]
    )
    print("wrote", MP3, "dur=%.2fs" % (len(samples) / SR), "peak=%.3f" % peak)


if __name__ == "__main__":
    main()
