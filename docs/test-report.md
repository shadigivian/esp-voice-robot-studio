# Validation report — 2026-10-17

## Standalone repository validation

The independent `esp-voice-robot-studio` export was installed with `npm ci` and checked separately from its original workspace. TypeScript and lint passed. The default suite passed **38 tests with 3 expected skips** (PostgreSQL and the two opt-in HTTP targets were not configured). All **5 Playwright tests passed** against the exported app's own isolated demo on a separate local port. These checks make no paid provider requests and operate no physical board.

The GitHub Actions workflow repeats the checks, browser tests and production build on Linux. Credentials, private data, dependency directories and generated artifacts are excluded; only the placeholder `.env.example` is published. The original validation notes below describe the earlier companion-workspace phase, including its optional firmware checks and larger HTTP-enabled run.

## Completed checks

- `npm run typecheck`: passed with TypeScript 5.9.3 and project Node 22.23.3.
- `npm run lint`: passed with ESLint 10.13.0. Errors were fixed, not disabled to obtain a pass.
- `npm run build`: passed with Next.js 16.4.2/React 19.3.1; all management and API routes compiled. Production startup on loopback passed.
- `npm audit --json`: **0 known vulnerabilities** in the final dependency lockfile.
- Deterministic backend, parser, transport and actual local HTTP checks: **40 passed, 1 PostgreSQL test skipped**, with both HTTP targets explicitly configured. No provider network call is made by these tests.
- Strict TypeScript harness for the Deno adapter: passed. The helper created a reviewable copy of the real existing Deno entry point and copied the upstream license; parent server sources were not changed.
- Default firmware and optional `ELATO_MANAGEMENT=1` firmware: both compiled successfully. See [firmware-verification.md](firmware-verification.md) for exact commands, RAM/flash sizes, warnings and the decoder-reset review fix.
- `git diff --check`: passed. Pre-existing working-tree changes were preserved.
- UI/UX follow-up: `npm run test:ui` passed **5 Playwright tests** in installed Google Chrome, including real saves, unsaved-navigation confirmation, mobile/keyboard navigation, privacy, persisted language/theme and stale-refresh ordering. Desktop/mobile screenshots were inspected; no captured page errors or horizontal overflow. See [UI/UX review](ui-ux-review.md) for reference/source locations and reproduction.

## Reproduce the application checks

From `firmware-arduino/management-panel`:

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run test:ui
npm run build
```

Default tests skip the two HTTP targets and the database integration target when they are not supplied. Start the isolated demo separately with `npm run demo`. Then run the HTTP tests using PowerShell:

```powershell
$env:TEST_APP_BASE_URL='http://127.0.0.1:3100'
npm test
```

On Linux:

```sh
TEST_APP_BASE_URL=http://127.0.0.1:3100 npm test
```

The production setup smoke check uses `TEST_SETUP_BASE_URL` pointing to an **explicitly unconfigured** local production process (validated on port 3101). It asserts that auth reports demo=false/configured=false, control returns 503/SETUP_REQUIRED, attempting demo creates no cookie, and the login/dashboard/devices/characters/integrations shells serve Persian RTL HTML with security headers. Do not point this check at a configured production service.

The final full run set both HTTP target variables. The PostgreSQL integration test additionally requires `TEST_DATABASE_URL` for an explicitly chosen, migrated disposable test database. It was skipped here because no test database was supplied; no migration was run against an existing development or production database.

## Coverage and evidence

Backend tests cover canonical Wi-Fi station MAC validation; registration without online status; provisioned identity proof; claim/nonce/connection binding; five-minute expiry; persisted five-attempt lockout; consumed-code replay; concurrent ownership; device-scoped short-lived rotation/revocation; forged workspace/device IDs; viewer permissions; snapshot independence; role/source retention confirmation; rollback excluding revoked sources; command capability/expiry/ACK; heartbeat expiry; and per-window rate limits.

Knowledge tests exercise corrected text indexing, idempotent jobs, ready versus published revisions, two devices sharing a character without sharing sources, cross-device provider candidates, stale index results, deletion during retrieval, superseded jobs, failed extraction requiring review, and active-session revocation when a published source revision changes. Usage tests verify trusted provider events, deduplication, independent response deltas and budgets that remain enforced after conversation deletion. Privacy tests verify default-off transcripts, retention, clean sessions and post-opt-out rejection of message storage.

The parser tests use actual PDF syntax and a Unicode font map for mixed Persian/English text, a real password-protected Standard Security Handler fixture, an image-only page, corrupt input, type/signature mismatch, binary/invalid UTF-8, page/byte/text bounds and timeout termination. OCR is not simulated and scanned text is never invented.

The HTTP lifecycle test runs against the built Next.js application. It signs into two isolated demo workspaces, creates a pending device, checks cross-origin/cross-workspace denial, uploads a private Persian source, downloads it only as the authorized workspace, approves/indexes/selects/publishes it, retrieves it through the shared Playground service, verifies transcript privacy, rejects paid demo voice, deletes the source, verifies loss of file/retrieval access and logs out. This exposed a reload/bundle error-classification bug during development; application errors now use a shared symbol brand and the final clean-process run passes.

Transport tests use real loopback HTTP/WebSocket sockets with deterministic provider/encoder fixtures. They execute the actual simulator process and managed upgrade handler, including token/browser-origin denial, command ACKs, streaming PCM boundaries, manual interruption, discarded old-generation callbacks and source revocation. They do not represent a successful OpenAI or physical audio session.

## Explicitly unverified

- PostgreSQL runtime/multiworker integration and the additive migration on a real database: **skipped, TEST_DATABASE_URL unavailable**. Schema and repository code were implemented; no remote database success is claimed.
- Live OpenAI text, TTS, Realtime/WebRTC and Live access, real vector-store indexing and billing: **not run**. Server credentials/model access were not supplied or inferred. Integration buttons and explicit voice/session actions are available after setup.
- Native `deno check` and running the adapter on the existing deployed Deno server: **not run, Deno unavailable**. The strict Node TypeScript harness and fixture transport tests passed.
- Microphone permission/device behavior and audible playback: **not run**. The UI/UX follow-up completed visual/mobile/keyboard QA with Playwright and installed Chrome; these browser checks do not establish media or physical device behavior.
- Physical OLED, microphone, amplifier/speaker, secure provisioning, trusted certificates, NTP, acoustic timing and reconnect/cancel buffer behavior: **not run, no board operation performed**. OLED controller/address/pins remain unknown in the hardware profile. Optional management mode stays disabled in the normal PlatformIO configuration.

No Git push, public deployment, production migration or firmware upload occurred. Temporary loopback application processes used for the initial backend validation were stopped after checks. The UI/UX follow-up reused and left running the existing local demo on port 3100, and closed its own browser processes.
