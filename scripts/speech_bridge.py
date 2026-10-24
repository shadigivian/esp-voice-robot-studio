"""Loopback-only Persian speech bridge. Install speech-requirements.txt first.

Piper is a separately installed GPL-3.0-or-later dependency; the selected voice's
dataset is CC0 (see its downloaded MODEL_CARD). No engine code is bundled here.
"""

from __future__ import annotations

import argparse
import hmac
import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import numpy as np

VOICE_NAME = "fa_IR-amir-medium"
SAMPLE_RATE = 24_000
MAX_BODY_BYTES = 32 * 1024
MAX_TEXT_LENGTH = 3_000
MAX_AUDIO_BYTES = 2 * 1024 * 1024
READ_TIMEOUT_SECONDS = 5


class AudioLimitError(ValueError):
    """The generated audio exceeds this bridge's response limit."""


def read_token(env_file: Path) -> str:
    """Read only the bridge setting from a dotenv file, without shell evaluation."""
    token = None
    with env_file.open(encoding="utf-8-sig") as source:
        for line in source:
            setting = line.strip()
            if setting.startswith("export "):
                setting = setting[7:].lstrip()
            name, separator, value = setting.partition("=")
            if separator and name.strip() == "SPEECH_BRIDGE_TOKEN":
                value = value.strip()
                if value.startswith('"'):
                    value = json.loads(value)
                elif value.startswith("'") and value.endswith("'"):
                    value = value[1:-1]
                token = value
    if not isinstance(token, str) or len(token) < 16 or any(c.isspace() for c in token):
        raise ValueError("SPEECH_BRIDGE_TOKEN must contain at least 16 non-space characters")
    return token


def synthesize_pcm24(voice: Any, text: str) -> bytes:
    """Normalize Piper's mono PCM16 output to 24 kHz little-endian PCM16."""
    audio_parts = []
    source_rate = None
    sample_count = 0
    for chunk in voice.synthesize(text):
        rate = chunk.sample_rate
        if (
            not isinstance(rate, int)
            or rate <= 0
            or chunk.sample_width != 2
            or chunk.sample_channels != 1
            or (source_rate is not None and source_rate != rate)
        ):
            raise ValueError("Unsupported speech audio format")
        source_rate = rate
        data = chunk.audio_int16_bytes
        if len(data) % 2:
            raise ValueError("Incomplete PCM16 sample")
        sample_count += len(data) // 2
        output_samples = round(sample_count * SAMPLE_RATE / source_rate)
        if output_samples * 2 > MAX_AUDIO_BYTES:
            raise AudioLimitError("Speech output exceeds the response limit")
        if data:
            audio_parts.append(np.frombuffer(data, dtype="<i2"))
    if not audio_parts or source_rate is None:
        raise ValueError("Speech produced no audio")
    samples = np.concatenate(audio_parts)
    if source_rate == SAMPLE_RATE:
        return samples.astype("<i2", copy=False).tobytes()
    output_samples = max(1, round(len(samples) * SAMPLE_RATE / source_rate))
    source_positions = np.arange(len(samples), dtype=np.float64)
    output_positions = np.arange(output_samples, dtype=np.float64) * source_rate / SAMPLE_RATE
    result = np.interp(output_positions, source_positions, samples)
    return np.rint(np.clip(result, -32768, 32767)).astype("<i2").tobytes()


class SpeechServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, port: int, voice: Any, token: str):
        self.voice = voice
        self.token = token.encode("utf-8")
        self.synthesis_lock = threading.Lock()
        super().__init__(("127.0.0.1", port), SpeechHandler)


class SpeechHandler(BaseHTTPRequestHandler):
    server: SpeechServer

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(READ_TIMEOUT_SECONDS)

    def log_message(self, _format: str, *args: Any) -> None:
        # Request text, auth headers and generated speech must not enter logs.
        pass

    def reply(self, status: int, body: bytes, content_type: str = "application/json") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        if content_type == "audio/pcm":
            self.send_header("X-Audio-Sample-Rate", str(SAMPLE_RATE))
        self.end_headers()
        self.close_connection = True
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, socket.timeout):
            pass

    def error(self, status: int, code: str) -> None:
        self.reply(status, json.dumps({"error": code}).encode("utf-8"))

    def browser_request(self) -> bool:
        if self.headers.get("Origin") is not None:
            self.error(403, "browser_requests_forbidden")
            return True
        return False

    def read_body(self, length: int) -> bytes:
        # A total deadline also bounds clients that slowly drip bytes.
        deadline = time.monotonic() + READ_TIMEOUT_SECONDS
        parts = []
        remaining = length
        while remaining:
            wait = deadline - time.monotonic()
            if wait <= 0:
                raise TimeoutError("Body deadline exceeded")
            self.connection.settimeout(wait)
            part = self.rfile.read1(min(remaining, 8192))
            if not part:
                break
            parts.append(part)
            remaining -= len(part)
        return b"".join(parts)

    def do_GET(self) -> None:
        if self.browser_request():
            return
        if self.path != "/health":
            self.error(404, "not_found")
            return
        self.reply(200, json.dumps({"ready": True, "voice": VOICE_NAME}).encode("utf-8"))

    def do_POST(self) -> None:
        if self.browser_request():
            return
        if self.path != "/speech":
            self.error(404, "not_found")
            return
        supplied = self.headers.get("Authorization", "")
        candidate = supplied[7:].encode("utf-8") if supplied.startswith("Bearer ") else b""
        if not hmac.compare_digest(candidate, self.server.token):
            self.error(401, "unauthorized")
            return
        if self.headers.get("Transfer-Encoding"):
            self.error(400, "transfer_encoding_unsupported")
            return
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self.error(411, "content_length_required")
            return
        if length <= 0 or length > MAX_BODY_BYTES:
            self.error(413, "body_limit_exceeded")
            return
        if self.headers.get_content_type() != "application/json":
            self.error(415, "json_required")
            return
        if not self.server.synthesis_lock.acquire(blocking=False):
            self.error(429, "speech_busy")
            return
        try:
            try:
                body = self.read_body(length)
                if len(body) != length:
                    self.error(400, "incomplete_body")
                    return
            except (socket.timeout, TimeoutError):
                self.error(408, "request_timeout")
                return
            try:
                payload = json.loads(body)
            except (ValueError, UnicodeDecodeError):
                self.error(400, "invalid_json")
                return
            if not isinstance(payload, dict):
                self.error(400, "object_required")
                return
            text = payload.get("text")
            if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_LENGTH:
                self.error(400, "invalid_text")
                return
            if payload.get("voice") not in (None, "", "default", VOICE_NAME):
                self.error(400, "unsupported_voice")
                return
            try:
                audio = synthesize_pcm24(self.server.voice, text.strip())
            except AudioLimitError:
                self.error(422, "audio_limit_exceeded")
                return
            except Exception:
                self.error(500, "speech_failed")
                return
            self.reply(200, audio, "audio/pcm")
        finally:
            self.server.synthesis_lock.release()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, default=Path(".env.local"))
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    try:
        token = read_token(args.env_file)
    except (OSError, ValueError):
        parser.error("Cannot load SPEECH_BRIDGE_TOKEN from the selected env file")
    from piper import PiperVoice

    voice = PiperVoice.load(args.model)
    server = SpeechServer(args.port, voice, token)
    print(f"Persian speech ready on http://127.0.0.1:{args.port}; voice={VOICE_NAME}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
