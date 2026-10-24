# Qwen integration validation

Verified on 2026-10-24 using the local Windows workstation. No live cloud key
was supplied and no paid model request was made.

## Completed checks

- `npm run typecheck`: passed.
- `npm run lint`: passed, including the new recorder and Qwen panel components.
- `npm test`: 64 tests including subtests; 61 passed, 3 conditional integration
  tests skipped, 0 failed. The skipped tests require an explicitly configured
  PostgreSQL database or a separately running HTTP fixture application.
- `npm run build`: passed with Next.js 16.4.2 and the pinned local Node 22.23.3.
- `npm run test:ui`: 6 Chrome tests passed. The new Qwen case executes the real
  AudioWorklet recorder with Chrome's fake microphone and a deterministic
  authenticated HTTP voice response; it checks recording, PCM submission and
  audio playback without contacting a provider.
- `platformio run -e esp32-s3-devkitc-1`: passed. Static RAM 63,348 bytes;
  firmware flash usage 1,222,465 bytes. No upload was performed.
- The separately packaged source also builds with
  `platformio run -e esp32-s3-devkitc-1 --project-dir management-panel/companion/firmware-arduino`:
  passed; RAM 63,348 bytes and flash 1,222,305 bytes. Its generated `.pio`
  files are ignored and are not included in the GitHub source package.
- The managed Deno module passed the strict Node TypeScript compatibility
  harness using `integration/deno/node-typecheck.d.ts`.
- Native Deno 2.9.6 checked both the actual installed
  `management/managed-voice.ts` and the complete companion `main.ts`: passed.
  The original dependency lockfile was preserved and checked in frozen mode.
  Narrow legacy compatibility fixes load the ambient declarations, use the
  correct Node WebSocket type and guard two existing provider callback cases.
- Companion installation fixtures verify compatible source detection,
  preservation of legacy authentication/listener behavior, idempotent hook
  updates, removal of bearer-header logging, source-only destinations and
  rejection of linked destination paths.

The Qwen fixtures cover workspace URL/auth construction, session readiness,
exact 16 kHz PCM input, odd-byte sample boundaries, 24 kHz provider audio,
playback acknowledgements, scoped tools, greetings, usage and transcript policy,
manual interruption, discarded old callbacks, provider rejection, source
revocation, voice samples, browser-turn cancellation and local knowledge access.
Existing OpenAI and simulator tests remain in the suite.

The restricted runner initially blocked `tsx` from reading Windows user
information (`uv_os_get_passwd`). The complete test run succeeded outside that
restriction. Local commands also used Node's `--preserve-symlinks` and
`--preserve-symlinks-main` flags to avoid the runner's ancestor-path restriction.

## Checks requiring deployment configuration

A live Qwen session, actual PostgreSQL/Supabase operation,
HTTPS/WSS certificates and a physical microphone/speaker/touch session were not
verified by these deterministic tests. The user has not yet obtained the Qwen
API key or Workspace ID. Model availability and Persian voice quality must be
tested after those settings are supplied.

The OLED controller, geometry and address are still unknown. GPIO8/9 are
reserved and the display is left uninitialized. Explicit USB pairing is
implemented so pairing does not depend on an assumed OLED driver. Board
flash/PSRAM settings must match the actual ESP32-S3 module before upload.

Qwen knowledge uses scoped local keyword search over approved persisted
revisions. It does not claim semantic retrieval. Existing foreign-provider
indexes require an explicit migration; cleanup is not silently acknowledged by
the local provider for files it does not own.
