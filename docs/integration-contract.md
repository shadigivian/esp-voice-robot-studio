# Optional external voice server integration

This repository includes an adapter for a separately installed compatible ElatoAI Deno voice server. It does not include the full voice server or firmware, and the local demo does not require either. The original integration was reviewed against the server under `server/deno` in the ElatoAI companion checkout. Its `main.ts` owns one HTTP/WebSocket listener, authenticates legacy user JWTs through `utils.ts` / Supabase, then chooses a provider. Its `models/openai-live.ts` uses the separate Live API, `session.start`, 24 kHz PCM and Responses delegation. The managed integration is additive; legacy provider/authentication paths are preserved. Check compatibility with the actual server revision before applying a generated patch.

The existing `utils.ts` `createOpusPacketizer` creates a per-connection 24 kHz mono encoder with 120 ms frames. Firmware sends 16 kHz mono PCM16 and decodes binary Opus. This is an application transport contract, independent of the provider's websocket schema.

## Install into the existing listener

From this repository's root, pass the path to your external compatible server explicitly. Replace the example path with its actual location:

```sh
node scripts/prepare-deno-integration.mjs /path/to/ElatoAI/server/deno/main.ts
```

PowerShell also accepts a quoted Windows path, such as `"D:\projects\ElatoAI\server\deno\main.ts"`.

The command writes **only** `integration/prepared/main.ts`, `integration/prepared/management/` and the accompanying license inside this repository. It verifies the expected upgrade-handler marker and refuses a duplicate hook. Review the generated diff against the existing server. Install that reviewed main.ts plus the management directory on the existing Deno server through the normal release process; do not start another voice listener. External source files and production are not modified automatically. The prepared main.ts still relies on the external server's other modules; it is not a complete standalone server.

The generated patch imports `createManagedVoiceUpgrade`, passes the existing `createOpusPacketizer`, and adds `if (await tryManagedUpgrade(req,socket,head)) return;` at the start of the current upgrade handler. `/managed-voice` uses managed device tokens. All other paths continue through legacy JWT/Supabase authentication. The prepared copy also removes the existing `console.log('foobar upgrade', req.headers)` statement, which would otherwise log bearer credentials.

Server-only environment:

```dotenv
MANAGEMENT_BASE_URL=https://panel.example.invalid
MANAGEMENT_ADAPTER_SECRET=<different-random-server-to-server-secret>
OPENAI_API_KEY=<existing-server-secret>
OPENAI_LIVE_MODEL=gpt-live-1
OPENAI_LIVE_BACKEND_MODEL=gpt-5.6-luna
OPENAI_LIVE_TURN_IDLE_MS=900
# Only permit an explicitly configured loopback panel in local development:
MANAGEMENT_ALLOW_LOCAL_HTTP=false
```

Use the same `MANAGEMENT_ADAPTER_SECRET` on the panel and Deno server. The configured management URL is operator-controlled, never a model/user-provided URL; the client rejects embedded credentials, remote HTTP and redirects. WSS TLS terminates at the existing trusted proxy/server. Forward Upgrade and bearer headers for `/managed-voice`; protect this device-only route from inappropriate browser access. Deploy the panel's PostgreSQL migrations and provision device identities separately before pairing.

Verify the installed copy with the deployed Deno version:

```sh
deno check management/managed-voice.ts main.ts
deno run -A --env-file=.env main.ts
```

Use the existing deployment command/port in production. The local development command inherits the existing `DEV_MODE`, `HOST`, `PORT` behavior. Model access is not inferred from the presence of an API key. Provider rejection produces an actual failed session; no demo fallback or fake audio is supplied.

## Runtime authorization and context

The panel provides `POST /api/device`; `ManagementClient` authenticates using a device token. The initial lookup determines device/workspace; `start_session` returns a new live session and a pinned published configuration. The adapter uses `context.instructions` and `context.tools` produced by the exact same backend `buildContext` as the text Playground. No prior visitor's conversation is injected. Draft editing never changes live prompts. Normal configuration changes apply on a subsequent interaction; source revocation and device revoke override pinning.

The model sees only `search_device_knowledge(query)`, `get_verified_facts(query)`, `get_device_public_profile()` and `end_session(reason)`. Tool arguments reject extra device/workspace/file/vector-store identifiers. The backend derives scope from the token and validates the session. Search/facts use that same active-session context as Playground. Both before and after retrieval the adapter rechecks the knowledge epoch, preventing an in-flight old result from entering a revoked context. The server independently filters active source IDs and revisions. A one-second authorization poll and a short output lease terminate stale sessions even when the model does not call a tool.

Transcript storage follows `privacy.storeTranscripts`, default false. When disabled, transcript deltas are not accumulated or forwarded as telemetry, and tool events contain only name/status. `store:false` is explicitly sent to the Live session. Do not enable legacy DEV_MODE PCM debug recording for managed audio; this adapter creates no debug PCM file. Provider usage comes from trusted `response.completed` / `session.closed` events. Unknown/unfinalized usage stays unconfirmed and is not converted to estimated remaining account balance. A finalization timeout does not mean successful provider completion.

## Provider schema and interruption

The schema was checked against the [official voice WebSocket guide](https://developers.openai.com/api/docs/guides/voice-websockets), [Live session lifecycle](https://developers.openai.com/api/docs/guides/live-conversations), [Live delegation/tools](https://developers.openai.com/api/docs/guides/live-delegation), and [retrieval guide](https://developers.openai.com/api/docs/guides/retrieval). Live uses `/v1/live/sessions`, `session.input_audio.append`, `session.output_audio.delta`, and nested `response.event` tool calls. It is not interchangeable with Realtime `input_audio_buffer.append` / `conversation.item.create`.

Live has no primary output-audio-done event. This integration retains the existing server's configurable idle-gap boundary, then waits for firmware playback ACK before unmuting input. A pause may split a spoken turn. Muting input alone does not cancel generated speech, so manual cancellation closes the old provider connection, clears local state and rejects its late callbacks by generation. The new upstream starts with clean published context. No undocumented Live `response.cancel` event is sent.

## Verification and known setup requirements

`node --test integration/deno/core.test.mjs` exercises URL protections, scoped tool arguments, token revalidation, source-revocation races, stale generations and streaming PCM boundaries without network or provider costs. On the restricted Windows runner, Node may require `--preserve-symlinks --preserve-symlinks-main` to avoid an ancestor-directory lstat restriction.

Run `node --test integration/deno/*.test.mjs` for the complete integration suite. It also starts a loopback HTTP fixture for the real simulator process and the actual managed WebSocket upgrade handler with a deterministic provider transport. The handler test rejects missing credentials/browser origins, streams fixture binary packets, interrupts and discards late old-generation audio, then revokes the knowledge epoch and observes playback clearing and connection termination. These tests exercise real local sockets; they do not verify TLS certificates, actual OpenAI access or physical hardware. A strict TypeScript harness (`node-typecheck.d.ts`) checks the Deno adapter against the same `ws` declarations on Node when native Deno is unavailable.

During the original companion-project review, the integration-preparation command was exercised against its actual main.ts; it created reviewed local output only. That historical check does not establish compatibility with another server revision. No production release, live model request, actual pairing, board flash or hardware audio verification is implied. OLED identity/wiring, per-board secure provisioning, deployed CA certificates, database/operator setup and actual provider access remain deployment prerequisites. The browser voice path is a separate authenticated test-session feature; `/managed-voice` intentionally accepts physical-device credentials rather than exposing them to the browser.
