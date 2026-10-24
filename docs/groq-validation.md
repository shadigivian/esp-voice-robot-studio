# Groq and Persian speech validation

Verified on the Windows workstation on 2026-10-24. No credentials are included
in this repository. Private panel and Deno environment files select Groq and
the local Persian speech bridge.

## Completed local checks

- Application TypeScript and ESLint: passed.
- Production build of the original standalone checkout: passed with Next.js
  16.4.2 and Node 22.23.3, including its private local configuration.
- All seven Chrome scenarios passed: the existing six cases and the new Groq
  push-to-talk case. Qwen and Groq both capture real synthetic microphone frames
  through AudioWorklet and play deterministic authenticated responses.
- Native Deno 2.9.6 checked the installed complete companion `main.ts` and
  `management/managed-voice.ts` with cached, frozen dependencies: passed.
- Complete Node suite: 78 tests including subtests; 75 passed, 3 skipped for
  explicitly configured database/application fixtures, 0 failed.
- Physical Groq adapter fixtures cover VAD, processing notification, paced
  Opus delivery, playback acknowledgements, scoped tools, source revocation,
  touch cancellation and conservative usage accounting after interruption.
- Seven Python bridge tests passed, including authentication, request limits,
  browser-origin rejection, concurrent synthesis rejection and PCM conversion.
- The separately installed Piper 1.8.0 engine generated real Persian speech.
  An authenticated local HTTP synthesis returned 200 and 118,144 bytes of mono
  PCM16 at 24 kHz. The review sample is local and ignored by Git.
- The bridge was then installed and started in the original standalone project.
  Its configured private token produced a second synthetic Persian sample:
  HTTP 200, 142,106 bytes, mono PCM16 at 24 kHz. Missing authentication returned
  401. The process listens only on `127.0.0.1:8765`.

## Live cloud result

Both a models-list request and a minimal Qwen chat request to the fixed Groq
API returned **HTTP 403 Forbidden**. Access to the supplied account/key and
selected model is therefore unverified. The response does not establish whether
the cause is account access or a network restriction. No live transcription or
complete cloud conversation has passed.

The model `qwen/qwen3.8-27b` is a preview model and can be changed through
`GROQ_TEXT_MODEL`. Verify account access before relying on it. Tests use fake
credentials and deterministic local HTTP responses; they do not validate the
live account or Persian recognition quality.

## Deployment and hardware limits

Database and Supabase Auth credentials, trusted HTTPS/WSS, device provisioning
and a physical microphone/speaker/touch test are still required. No board was
flashed during the Groq changes. The existing ESP32-S3 wiring and firmware are
unchanged; OLED initialization still awaits its controller and dimensions.

The bridge runs only on loopback, separately from the panel and Deno server.
Piper and its voice are separate local dependencies, not committed assets.
See [the Persian setup guide](groq-setup.fa.md) for setup and startup commands.
