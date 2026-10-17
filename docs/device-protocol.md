# Device protocol v1

The identifier is the ESP Wi-Fi **station** MAC returned by `WiFi.macAddress()`, normalized uppercase with colons. The MAC is public metadata. It never authenticates a claim, heartbeat, retrieval request or voice connection.

## Provisioning and claim

An operator registers a different random bootstrap secret for each board through `ControlService.provision(mac, secret)` / the operator provisioning CLI. Deliver that same secret over a trusted local provisioning channel using `ManagementProtocol::provision(httpsOrigin, uniqueSecret, voiceHost, 443)`. The secret must contain at least 256 random bits (for example 32 random bytes encoded as base64url). The firmware API is deliberately not exposed as a public HTTP endpoint. Provisioning does not establish ownership.

The firmware stores credentials in NVS namespace `robot-mgmt`. Configure NVS encryption, flash encryption and secure boot for the deployed board as appropriate; this source does not claim those deployment controls are already enabled. Never compile one shared secret into a fleet. Configure the correct trusted root certificate through `CA_cert` for both deployed management and voice origins; never use `setInsecure()`.

The opt-in setup starts UTC time synchronization with public NTP servers before TLS requests. If time cannot synchronize, management requests wait; no insecure TLS fallback occurs. Command expiry is checked on the device before application as well as by the server before ACK.

1. An authenticated panel administrator creates a pending claim with the robot name and MAC. Pending claims do not permanently reserve the MAC.
2. The physical device sends `POST /api/device` with `action:"bootstrap"`, `mac`, its `bootstrapSecret`, fresh random `connectionId` and `nonce`. It may include a known `claimId`; otherwise the authenticated MAC discovers a pending claim. The response contains `claimId`, `code`, `expiresAt`.
3. The device shows the code through `managementRenderPairingCode(code, expiresAt)`. The controller, dimensions, address and pins of this project's OLED are not identified. Until a board-specific renderer exists, the opt-in firmware does **not** request or log a pairing code. `hardware-profile.example.json` records this setup requirement.
4. The administrator submits the code to the panel. The server enforces expiry, attempt limit and transaction isolation. Code verification is bound to the claim, nonce and connection. Replaying a consumed claim fails.
5. The device polls `claim_status` with the same bootstrap identity, returned `claimId`, `connectionId` and `nonce`. Once paired, the server issues device-scoped `token`, rotating `refreshToken`, `expiresAt`, `deviceId`. Those credentials never appear in the panel bootstrap response.

Codes expire after five minutes and permit five verification attempts. A new boot uses a new nonce and connection identifier. The bootstrap secret is not an API/provider key or a user token.

## HTTP contract

All device calls use `POST /api/device` and JSON. The Next.js route responds `{data: result}` on success and `{error:{code,message}}` on failure. The provided clients accept this envelope and direct objects for compatibility. Token-authenticated calls put `Authorization: Bearer <device token>` in the header; the route/service also accepts the `token` JSON field used by the firmware. Responses and requests are never logged by these clients.

- `refresh {refreshToken}` returns a new token/refresh pair. Old refresh credentials become unusable. Firmware refreshes at ten minutes; tokens expire after fifteen minutes.
- `rotate {token}` rotates the device credential pair explicitly.
- `heartbeat {token,connectionId,capabilities,conversation}` returns `{deviceId,configVersion,published,commands,knowledgeEpoch}`. Heartbeats run every ten seconds. Offline is calculated from server receipt time, never from an open panel or browser voice test.
- `ack {token,commandId,status,configVersion?,error?}` accepts only the device's own unexpired pending command. `status` is `applied` or `failed`; receipt alone does not apply a command.
- `context`, `search {query}`, `facts {query}`, `start_session {type:"live"}`, `end_session {sessionId,reason}` support the existing voice-server adapter. Active-session context/search/facts also include `sessionId` to preserve the pinned published snapshot and enforce revocation.
- `server_event {token,sessionId,event}` additionally requires `X-Management-Adapter-Key` matching the server secret. Only the trusted server records provider usage, errors, tool metadata and permitted transcript messages.

Current firmware commands: `volume` with `{value:0..100}` applies both existing speaker streams; `config` with `{configVersion}` durably stores the received version pointer and ACKs it. Prompts, role and knowledge remain server-side, and an existing conversation retains its pinned snapshot. The received version takes effect in the next new conversation. Unsupported commands return a failed ACK. OLED sleep and reboot are not advertised. Expired commands and missing ACKs fail server-side; changing a form alone never marks a command applied.

## Existing voice transport

The adapter adds `/managed-voice` to the **existing** Deno listener. A device connects using WSS, its scoped bearer token, `X-Device-Mac` and `X-Elato-Playback-Ack: 1`. The MAC is diagnostic; the token establishes the device/workspace. Browser Origin headers are rejected on this route. No OpenAI API key enters the ESP or browser.

The existing wire format is preserved: raw PCM16 little-endian, mono, **16 kHz** binary frames from ESP; binary **Opus, mono, encoded at 24 kHz**, 120 ms packets from the voice server. The existing firmware I2S output/Opus decode configuration uses 48 kHz. The adapter resamples incoming 16 kHz PCM to 24 kHz across frame boundaries before Live input; it reuses `createOpusPacketizer` from the existing server. Do not switch the ESP connection to provider JSON audio or raw provider PCM.

Device instructions are JSON `{type:"instruction",msg:...}`. `PLAYBACK.COMPLETE` includes the matching `playback_id` after speaker buffers and DMA drain. `END_SESSION` closes the interaction. `INTERRUPT` / `RESPONSE.CANCEL` drops queued input and encoder state, closes the old upstream generation, and starts a clean upstream context. Late callbacks from the old generation are rejected.

Server controls retain `RESPONSE.CREATED`, `RESPONSE.COMPLETE`, `RESPONSE.ERROR`, `SESSION.END` compatibility. Managed turns use `playback_id` for the drain handoff. `AUDIO.CLEAR` immediately mutes the amp, clears pending playback/restart state, resets the decoder and requests speaker-owned queue/DMA clearing. Microphone echo is not labelled AEC; the protocol remains half duplex.

Open sessions revalidate device/session authorization every second. A 1.5 second authorization lease stops output if validation stalls. Knowledge-epoch changes stop the old upstream and clear playback; a new interaction receives a clean context without copied history. Already transmitted network/audio hardware samples cannot be recalled instantaneously. Disconnect, credential refresh, revoke, source deletion and cancellation must still be tested on the actual board.

## Simulator

`scripts/device-simulator.mjs` follows the real HTTP claim/refresh/heartbeat/ACK contract; `--voice` also connects the existing WSS adapter. It is labelled simulator in capabilities, displays a simulated pairing screen, and never claims microphone capture, hardware speaker playback or a successful model request. Set `MANAGEMENT_BASE_URL`, `SIMULATOR_MAC`, the individually provisioned `DEVICE_BOOTSTRAP_SECRET`, and optionally `DEVICE_CLAIM_ID` / `VOICE_SERVER_URL`. Explicit `--once`, `--rotate` and `--voice` options are available. An optional `SIMULATOR_STATE_FILE` contains sensitive tokens: protect it and keep it outside version control.
