# Setup and operation

## Runtime and location

This is a standalone Next.js application. Run all commands from the repository root. Use Node.js **22.13+** and npm. The checked-in package lock pins resolved dependencies. A local development Node 22.23.3 binary is installed as a dev dependency; `npm run` uses it through npm's local PATH. Use a supported system Node 22 on Linux production. Docker is not required.

From Windows PowerShell, macOS or Linux:

```sh
git clone https://github.com/shadigivian/esp-voice-robot-studio.git
cd esp-voice-robot-studio
npm ci
npm run demo
```

Visit `http://127.0.0.1:3100/login`. Demo is explicit and isolated, and live audio is disabled. Do not set APP_MODE=demo on a real deployment. Missing production configuration produces Setup required.

## Existing PostgreSQL and Supabase Auth

Copy `.env.example` to `.env.local` (`Copy-Item .env.example .env.local` on PowerShell; `cp .env.example .env.local` on Linux). Set `DATABASE_URL` to the selected PostgreSQL database and `SUPABASE_URL`/`SUPABASE_ANON_KEY` to existing Supabase Auth. The anon key is not the service role. All database credentials and provider keys stay on the server. Keep `.env.local` private and excluded from Git. Do not use NEXT_PUBLIC_ prefixes for secrets.

The connection must use a trusted server role owning the new robot_* tables; RLS and revoked client grants intentionally prevent direct anonymous/authenticated browser access. The app verifies workspace membership before any management operation. A PostgreSQL connection without ownership/BYPASSRLS cannot silently bypass these policies and will fail configuration checks. Use the existing deployment's trusted database administration mechanism rather than weakening RLS.

Review `migrations/001_robot_management.sql`, then run **against the intended development database**:

```sh
npm run migrate
npm run operator -- workspace USER_UUID WorkspaceName
npm run operator -- member WORKSPACE_UUID USER_UUID viewer
```

Get USER_UUID from your existing Supabase Auth administration. The migration creates separately prefixed tables and records a checksum. It does not rewrite legacy users, devices or conversations. Re-running skips applied migrations. Do not edit an already-applied migration; add a new one.

Login uses your existing email/password Auth account. Provision initial accounts through the existing Supabase administration flow. The panel does not invent accounts or bypass membership. Workspace owner/admin can edit; viewers can inspect permitted data. Access and refresh tokens use HttpOnly SameSite cookies. Refresh is server-side, and Origin checks protect browser mutations.

## Provider and knowledge

For a Groq API key, use `AI_PROVIDER=groq` on both servers and follow the
[Persian Groq guide](groq-setup.fa.md). This path combines Groq Whisper and Qwen
text with a separately running local Piper speech bridge.

For the Qwen cloud path, follow [the Persian Qwen guide](qwen-setup.fa.md).
`AI_PROVIDER=qwen` selects DashScope text and realtime voice plus scoped local
keyword retrieval; no OpenAI key is required in that mode. Set the same provider
on the panel and managed Deno server. The OpenAI configuration below remains
available when `AI_PROVIDER=openai`.

Set `OPENAI_API_KEY`, an explicitly accessible `OPENAI_TEXT_MODEL` and `OPENAI_REALTIME_MODEL`, plus a supported `OPENAI_VOICE`. Optional `OPENAI_TRANSCRIPTION_MODEL` enables user audio transcription, and `OPENAI_TTS_MODEL` enables the explicitly requested character voice sample. Samples use the saved draft greeting/voice and are never requested automatically. The Integrations button tests model visibility; it does not prove a working microphone or live session. Model visibility and actual voice access can differ. Do not guess model access or paste keys into the browser.

```sh
npm run dev
```

In another terminal:

```sh
npm run worker
```

The worker polls every two seconds, runs bounded indexing jobs and retention cleanup, leases jobs across worker processes, and retries through explicit document actions. PDF extraction runs in a disposable worker thread with memory/time/page/text limits; it does not run on the voice event loop. OCR is not configured. Image-only, unreadable, encrypted or invalid PDFs require corrected text/review or replacement. Text/Markdown must be UTF-8. Review, approve, index, select and publish a source before live use.

Original uploads are private files under `PRIVATE_STORAGE_DIR`, organized by mode/workspace/device/document UUID. Keep this directory outside Next's public folder, owned by the server account; use an encrypted disk and include it in your backup plan. Application routes authorize every original download. Reviewed versions and retrieval state are stored in PostgreSQL; a device's vector store mapping stays server-only. Multiple app replicas need the same private storage volume. Do not upload source documents to public web hosting.

## Optional external voice server and physical devices

The full voice server and firmware are not included in this repository. The demo and management app do not require a sibling ElatoAI checkout. Physical-device voice requires a separately installed compatible ElatoAI Deno listener and matching managed firmware.

Set `VOICE_SERVER_URL` to that listener's `/managed-voice` WSS endpoint. Follow [integration-contract.md](integration-contract.md) to prepare and review an additive patch, passing the external server's `main.ts` path explicitly. The helper creates a separate prepared copy; it does not deploy over your server. Configure that server's `MANAGEMENT_BASE_URL`, `MANAGEMENT_ADAPTER_SECRET`, provider key/model and allowlisted HTTPS endpoint. Use the same adapter secret on the management app; never send it to a device or browser.

Each board needs a securely generated **unique 256-bit bootstrap secret**, the panel's trusted TLS CA, and its Wi-Fi station MAC. Deliver the identity locally through your trusted provisioning process. Register its hash with `npm run operator -- provision STATION_MAC` while `DEVICE_BOOTSTRAP_SECRET` is set temporarily in the operator environment. The command never prints the secret. Do not share a bootstrap key among boards or embed real keys in source control. Clear the operator environment afterwards.

In the companion firmware, management support is opt-in through `ELATO_MANAGEMENT`. The [example hardware profile](../hardware-profile.example.json) in this repository leaves the OLED driver/pins/address unknown. Pairing requires an actual OLED renderer callback and physically provisioned identity. Read [device-protocol.md](device-protocol.md) before enabling the flag in a compatible firmware checkout. A successful compile is not a hardware test. No OTA or factory reset feature is added by this app.

The simulator uses `MANAGEMENT_BASE_URL`, `SIMULATOR_MAC`, `DEVICE_BOOTSTRAP_SECRET` and optionally `DEVICE_CLAIM_ID`; `npm run simulator` connects to the actual management API. Enter its temporary simulated-screen code in the panel. A simulator cannot establish microphone, speaker or OLED correctness. `--voice` is an explicit live provider test and may cost money.

## Browser voice

In Qwen mode the authenticated browser uses bounded push-to-talk requests:
up to 15 seconds of PCM16/16kHz, server-owned tool execution, and a WAV reply.
Each recording is an independent session. The master key stays server-side;
the same authorization, knowledge revision and transcript rules apply. Qwen
samples use the realtime model and saved greeting. The following WebRTC flow
applies to OpenAI mode.

Browser voice starts only after a deliberate click. The panel requests a microphone, exchanges SDP through its own authenticated `/api/voice`, and establishes a WebRTC media session. The master API key and provider call ID remain on the server. Server sideband control dispatches the same scoped knowledge tools/context used by ESP and text tests. User transcription is available only if the transcription model is configured; assistant audio transcripts are transient unless content storage is opted in.

The backend polls session authorization; the browser polls every second and stops playback if access changes. Manual interrupt stops generation, clears playback and ends the session. Restart uses a clean session. Close/end/unmount stops all microphone tracks. This requires a persistent Node server; do not deploy the voice controller to short-lived serverless functions. Document revocation invalidates active sessions before physical index cleanup.

## Linux production

Set `APP_BASE_URL` to the public **HTTPS** origin. Terminate TLS in your existing reverse proxy and forward to `127.0.0.1:3100`; proxy WSS to your existing Deno listener. Keep database, secrets, disk storage and worker on trusted infrastructure. The Next server binds loopback. Start only after local validation:

```sh
npm ci
npm run build
npm start
```

Run the worker under your existing process supervisor as well. Use normal service restart, database/storage backups and environment secret management. Apply production migrations and deploy only after reviewing the prepared files and choosing the production target yourself.

## Limits, privacy and cost

Session duration/concurrency, daily sessions, measured token and voice duration budgets, request rate, source count, upload size/pages and parser time are enforced on the server. All limits are configurable in `.env.example`. Provider usage is recorded only from trusted server-side events. Unknown dimensions remain unavailable. No account balance is inferred and no currency price estimate is shown without a rate table. In-flight generation can exceed measured thresholds before a final usage event; these are guardrails, not a precise billing cap. Set provider-side project budgets too if desired.

Transcripts default off and raw audio is not saved. Enabling content storage requires explicit administrator choice and a retention duration. Tell people using the physical robot about that choice. Disabling content storage erases stored messages and prevents subsequent message telemetry. The worker removes expired content. Conversation deletion removes the authorized session; fresh interactions never restore prior visitor messages.
