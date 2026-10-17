# Historical companion firmware and voice-adapter verification

Verification date: 2026-10-17. This report records checks performed in the original ElatoAI companion checkout before this management application was exported as a standalone project. The full firmware, its local modifications, PlatformIO configuration and complete voice server are not bundled in this repository. These results are historical evidence, not a claim that the standalone project contains a buildable firmware distribution.

All firmware commands compiled local artifacts only. No COM-port upload, board flash, public deployment, production migration or paid provider request was performed during that review.

## Default firmware build

For a matching companion firmware checkout, run from its `firmware-arduino` directory with PlatformIO available on PATH:

```sh
platformio run -e esp32-s3-devkitc-1
```

Result after review: **passed**, 17.36 seconds for the incremental compile. RAM: **55,524 / 327,680 bytes** (16.9%). Flash: **1,238,033 / 2,097,152 bytes** (59.0%). A preceding full rebuild passed in 59.74 seconds. The active `platformio.ini` was not edited by the management integration and does not enable `ELATO_MANAGEMENT`.

The first sandboxed attempt was unable to write PlatformIO's existing `platforms.lock` under the user's compiler-cache directory. The same compile succeeded with approved access to that installed cache. This was a runner filesystem restriction rather than a compiler failure.

## Opt-in management build

In that matching companion firmware directory, the following PowerShell commands create a separate, ignored check configuration inside `.pio`, retaining the existing build flags and adding `ELATO_MANAGEMENT`. They do not rewrite `platformio.ini`. A fresh upstream firmware checkout may not contain the managed-device changes reviewed here; verify compatibility first:

```powershell
$managementCheckConfig = Get-Content -Raw -LiteralPath platformio.ini
$managementCheckConfig = $managementCheckConfig.Replace('build_flags =', "build_flags =`r`n    -D ELATO_MANAGEMENT=1")
Set-Content -LiteralPath .pio/management-check.ini -Value $managementCheckConfig
platformio run -c .pio/management-check.ini -e esp32-s3-devkitc-1
```

The opt-in build compiles the complete management header and callbacks, including the absent optional weak OLED renderer. It does not claim a display exists or that a claim succeeded. With an unidentified display or missing unique identity, firmware reports Setup required and does not issue/log a pairing code.

Result after the decoder-reset review fix: **passed**, 63.26 seconds. RAM: **55,828 / 327,680 bytes** (17.0%). Flash: **1,273,121 / 2,097,152 bytes** (60.7%). The final local artifacts correspond to this explicitly selected check configuration; the repository's normal configuration still leaves management disabled. Both configurations were compiled successfully; neither was uploaded.

## Compiler and warnings

Installed platform: Espressif32 6.10.0; framework Arduino-ESP32 package 3.20017.241212; Xtensa ESP32-S3 compiler 8.4.0+2021r2-patch5. Resolved libraries include ArduinoJson 7.4.3, WebSockets 2.7.3, ESPAsyncWebServer 3.12.1, audio-tools 0.9.9 and libopus 1.3.1. The configured flash partition permits a 2 MiB application and both configurations fit that partition.

Builds emitted existing deprecation warnings for ArduinoJson `containsKey` / `createNestedObject` and the button dependency's `ADC_ATTEN_DB_11`. No compiler/linker errors remained. Those warnings were not suppressed to obtain a pass.

## Adapter and transport tests

The adapter tests are included in this standalone project. From its repository root using Node 22:

```sh
node node_modules/typescript/bin/tsc --strict --noEmit --skipLibCheck --target es2023 --module esnext --moduleResolution bundler --allowJs --types node integration/deno/node-typecheck.d.ts integration/deno/managed-voice.ts
node --test integration/deno/core.test.mjs integration/deno/simulator.test.mjs integration/deno/managed-voice.test.mjs
node scripts/prepare-deno-integration.mjs /path/to/ElatoAI/server/deno/main.ts
```

The preparation command needs the actual external server path; it is optional and is not a demo prerequisite. On the original restricted Windows runner, Node additionally used `--preserve-symlinks --preserve-symlinks-main` to avoid an ancestor-directory filesystem restriction.

Recorded original results: strict TypeScript harness **passed**. Integration suite: **9 passed, 0 failed**, approximately 17.7 seconds. Preparation command: **passed**, writing only ignored local integration output. The actual external Deno main.ts remained untouched. See [test-report.md](test-report.md) for application checks and [integration-contract.md](integration-contract.md) for installation boundaries.

Tests cover protected management URLs, token failure, device-bound argument validation, post-search source-revocation races, streaming PCM conversion across odd byte/frame boundaries, the real simulator process over loopback HTTP, command ACKs, actual local WebSocket upgrades, browser-origin/token denial, binary audio forwarding, cancellation and late-generation rejection, and live knowledge-epoch revocation. Provider transport and Opus encoding are deterministic fixtures in the adapter transport test; no OpenAI connection is opened. Native `deno check` is **not run** because Deno is unavailable in this environment; the deployable adapter still needs native validation in the existing server's release environment.

## Historical companion firmware review

The review distinguished pre-existing working-tree changes from this task's additions. Existing INMP441 conversion, microphone/speaker rates and buffers, diagnostics, relay class, digital touch behavior, USB Wi-Fi setup, PSRAM check, shutdown handling and GPIO definitions were retained. No new display controller, I2C address or GPIO mapping was guessed.

In the reviewed companion implementation, with `ELATO_MANAGEMENT` undefined, no management task, bootstrap request, NTP setup or managed credential override is compiled. Legacy DEV/production WebSocket selection, target path, bearer header and playback ACK remain the existing behavior. Its mutex covers copying connection parameters as well as changing the socket; it is released on every new early return. The added cancellation handler acts only on an explicit `AUDIO.CLEAR` event. Its initially false queue-clearing flag leaves ordinary legacy playback unchanged.

The cancellation review found that the bundled Opus decoder owns its state in a vector while its `end()` calls `opus_decoder_destroy` on that same storage. Cancellation therefore safely reinitializes an already-active decoder through `begin()` and does not call that unsafe destruction path. Speaker queue consumption and DMA clearing remain on the speaker task; the network/control path mutes the existing amp pin and waits for the speaker's clear acknowledgement before a new spoken generation.

No management request/response body, device credential, bootstrap secret, pairing code or provider error body is logged. Pairing codes go only to the board-specific display callback; the explicitly labelled simulator prints its simulated device screen. The prepared server patch removes an existing raw request-header debug log that could expose bearer credentials. Provisioning checks persisted identity values before reporting success.

## Not verified on hardware or production

Physical OLED rendering/wiring, per-board secret delivery, flash/NVS encryption, trusted deployed certificates, NTP availability, actual microphone/speaker timing, cancellation of hardware buffers, network reconnection, battery telemetry and acoustic echo cancellation were not tested. Physical claim, revoke and final playback timing need a board test. Live API model access, native Deno runtime behavior, actual Opus acoustics and provider billing events need explicit deployment/opt-in testing. Browser voice is a separate authenticated test path; this device-only route does not grant browser access to device credentials.
