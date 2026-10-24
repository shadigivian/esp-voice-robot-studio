"""Contract tests; use only a fake voice and a synthetic authorization token."""

import http.client
import json
import threading
import unittest
from types import SimpleNamespace

import numpy as np

from speech_bridge import MAX_BODY_BYTES, MAX_TEXT_LENGTH, SpeechServer, synthesize_pcm24

TOKEN = "test-only-speech-token-123456789"


class FakeVoice:
    def __init__(self):
        self.entered = threading.Event()
        self.release = threading.Event()
        self.release.set()

    def synthesize(self, _text):
        self.entered.set()
        self.release.wait(timeout=3)
        yield SimpleNamespace(
            sample_rate=22050,
            sample_width=2,
            sample_channels=1,
            audio_int16_bytes=np.array([0, 1000, -1000] * 735, dtype="<i2").tobytes(),
        )


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.voice = FakeVoice()
        self.server = SpeechServer(0, self.voice, TOKEN)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.voice.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)

    def request(self, payload=None, headers=None, method="POST", path="/speech"):
        conn = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        body = json.dumps(payload or {"text": "test"}).encode()
        request_headers = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
        request_headers.update(headers or {})
        conn.request(method, path, body=body, headers=request_headers)
        response = conn.getresponse()
        result = (response.status, dict(response.getheaders()), response.read())
        conn.close()
        return result

    def test_resampling_and_response_contract(self):
        status, headers, body = self.request({"text": "hello", "voice": "fa_IR-amir-medium"})
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "audio/pcm")
        self.assertEqual(headers["X-Audio-Sample-Rate"], "24000")
        self.assertEqual(len(body), 4800)  # 100 ms of mono PCM16 at 24 kHz.
        self.assertFalse(body.startswith(b"RIFF"))
        self.assertGreater(np.max(np.frombuffer(body, dtype="<i2")), 0)

    def test_auth_and_browser_rejection(self):
        self.assertEqual(self.request(headers={"Authorization": "Bearer wrong"})[0], 401)
        self.assertEqual(self.request(headers={"Origin": "http://localhost:3100"})[0], 403)
        self.assertEqual(self.request(headers={"Origin": "null"})[0], 403)
        self.assertFalse(self.voice.entered.is_set())

    def test_input_bounds(self):
        for payload in ({"text": ""}, {"text": 42}, {"text": "x" * (MAX_TEXT_LENGTH + 1)}, {"text": "a", "voice": "other"}):
            self.assertEqual(self.request(payload)[0], 400)
        self.assertEqual(self.request(headers={"Content-Length": str(MAX_BODY_BYTES + 1)})[0], 413)
        self.assertEqual(self.request(headers={"Content-Type": "text/plain"})[0], 415)

    def test_busy_fails_without_waiting(self):
        self.voice.release.clear()
        results = []
        first = threading.Thread(target=lambda: results.append(self.request()[0]))
        first.start()
        self.assertTrue(self.voice.entered.wait(timeout=2))
        self.assertEqual(self.request()[0], 429)
        self.voice.release.set()
        first.join(timeout=3)
        self.assertEqual(results, [200])

    def test_health_and_missing_routes(self):
        status, _headers, body = self.request(method="GET", path="/health", headers={"Authorization": ""})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"ready": True, "voice": "fa_IR-amir-medium"})
        self.assertNotIn(TOKEN.encode(), body)
        self.assertEqual(self.request(path="/missing")[0], 404)

    def test_audio_output_limit(self):
        class TooLongVoice:
            def synthesize(self, _text):
                yield SimpleNamespace(sample_rate=24000, sample_width=2, sample_channels=1, audio_int16_bytes=b"\0" * (2 * 1024 * 1024 + 2))
        self.server.voice = TooLongVoice()
        self.assertEqual(self.request()[0], 422)

    def test_invalid_audio_format(self):
        class StereoVoice:
            def synthesize(self, _text):
                yield SimpleNamespace(sample_rate=24000, sample_width=2, sample_channels=2, audio_int16_bytes=b"\0" * 4)
        with self.assertRaises(ValueError):
            synthesize_pcm24(StereoVoice(), "test")


if __name__ == "__main__":
    unittest.main()
