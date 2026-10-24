# Architecture

With AI_PROVIDER=qwen, the panel uses DashScope Chat Completions, bounded server-owned browser voice turns, and local keyword retrieval over approved device revisions. The Deno adapter owns the physical realtime session and scoped tools. Companion firmware supplies the documented ESP32-S3 transport and explicit USB pairing. Existing OpenAI paths remain available when selected; OpenAI-specific details below apply to that provider.

The management application is a separate Next.js/TypeScript application under `firmware-arduino/management-panel`. It preserves the existing sibling frontend, Supabase migrations and voice services. The optional Deno integration adds an authenticated managed-device path to the existing voice server; it does not replace the original audio transport.

## Runtime boundaries

- The browser renders the Persian RTL management panel. It receives workspace-authorized data, never an OpenAI key, bootstrap secret, device token, vector-store ID or provider file ID.
- Next.js route handlers authenticate the administrator through Supabase, enforce same-origin cookie requests and delegate to `ControlService`. A verified Supabase user still needs a database workspace membership; claimed roles in request bodies have no authority.
- `lib/server/service.ts` owns claim, draft/publication, command, knowledge, session, privacy and usage transitions. `lib/server/context.ts` produces the common instructions and tool definitions used by text tests, browser voice and managed physical-device sessions.
- A separately run `scripts/worker.ts` processes approved-text indexing jobs and transcript retention. Knowledge-provider network calls run outside database transactions. Provider failures produce visible failed jobs rather than success or demo fallback.
- PostgreSQL stores persistent production data. Supabase supplies the existing authentication ecosystem. The database connection is server-only and is independent of Supabase browser JWT credentials.
- Explicit `APP_MODE=demo` uses in-memory data and deterministic local retrieval. Each signed demo session receives a separate workspace with three labeled sample devices. Real provider calls and browser audio are disabled in demo mode. Restarting the demo process clears that data.

## Persistence and transactions

`migrations/001_robot_management.sql` adds only `robot_*` tables. Devices, members, templates, sessions, audit entries, claims, credentials, ingestion jobs and vector-store mappings have separate relational rows. Flexible versioned configuration and document payloads are JSONB. Document histories, facts and configuration snapshots are embedded inside the parent device row, so they cannot independently acquire an invalid workspace/device association. Sessions, claims, credentials, jobs and store mappings have composite foreign keys to `(device_id, workspace_id)`.

Application-issued entity identifiers are UUIDs. Text database key columns also support the composite membership key, MAC bootstrap identity key and bounded rate-limit key. A partial unique MAC index applies only to paired hardware. Pending claims do not reserve someone else's MAC permanently.

`PostgresStore` uses a transaction-scoped advisory lock shared by all app/worker processes. It reads the state, authorizes and applies a transition, validates associations, persists changed rows and commits atomically. Upserts insert parents before children, and deletions run in reverse dependency order. A rejected pairing attempt commits its updated attempt counter before returning an API error. The database MAC constraint is a second ownership safeguard.

This repository deliberately serializes transactions and loads server-side state for a small installation. It is correct across multiple workers sharing the database but is not a high-volume query architecture. Replace aggregate scans with scoped SQL repositories and finer locking before a large fleet; do not remove the transaction or uniqueness safeguards.

RLS is enabled on every application table. Public, `anon` and `authenticated` table privileges are revoked and no client write policy exists. Browser access goes through the authenticated application server. The production database identity must own these management tables, or have equivalent explicitly configured server-only privileges; do not grant those privileges to the browser roles. Bootstrap hashes, code hashes, refresh hashes and token hashes live in dedicated private tables, separate from public device responses.

## Device ownership and operations

The operator enrolls a unique high-entropy bootstrap secret for each Wi-Fi station MAC. Only its hash is stored. A MAC alone never issues a token. An authenticated device obtains a six-digit OLED code bound to a claim UUID, device connection ID and nonce. The code lasts five minutes and accepts at most five attempts. Ownership assignment is transactional. The confirmed device consumes the claim exactly once to obtain a 15-minute device-scoped token and a rotating seven-day refresh credential. Refresh or rotation invalidates the previous credential. Revoking a device invalidates its credentials and current sessions.

Provisioning, connectivity and conversation are separate states. Registration and browser tests do not mark hardware online. Only authenticated device heartbeat updates `lastSeen`; the default online timeout is 60 seconds. Desired configuration version and acknowledged applied version remain separate. Commands have UUIDs, a two-minute expiry and an explicit pending/applied/failed state. Unsupported remote operations fail capability checks. A saved form never represents a firmware ACK.

## Configuration and sessions

Character templates contain behavior settings without private documents. Applying a template copies a character snapshot into one device's draft. Editing or archiving the template does not mutate existing devices. Draft and published configurations are separate; publication creates an immutable configuration history entry and a new desired version. Changing the role clears draft source selection unless the administrator explicitly confirms retaining knowledge. Rollback prepares a reviewable draft and excludes deleted or revoked sources.

Every interaction creates a new session with a configuration snapshot and knowledge epoch. Normal role, character and voice publication affects the next interaction. Disabling or deleting a source, changing verified facts or revoking credentials invalidates affected live sessions immediately in the application. Voice adapters poll session validity and must close the upstream conversation and clear audio when it becomes invalid. Endpoints reject further tool retrieval even before the adapter observes the change. Content already delivered over the network cannot be recalled.

Transcript storage is disabled by default. Technical session metadata is separate from optional messages. Opting out clears stored messages and prevents later transcript writes; retention clears expired messages and the worker runs cleanup independently of indexing. Raw audio is not stored. Provider tool payloads and private excerpts are not written into telemetry. Trusted adapter or server-side sideband events are the only usage sources; browser-supplied usage is not accepted as billing evidence.

## Limits and measurement

Server limits cover devices, documents, extracted text, session starts, active sessions, session duration, token issuance, claim polling, searches and management requests. Configurable measured daily token and voice-session-duration budgets stop subsequent sessions and reject continued session checks after their recorded limits are reached. Provider work already in flight can exceed a threshold before final usage arrives. These limits are operational safeguards, not a promise of exact provider billing.

Usage aggregates only known, authenticated provider measurements. A content-free daily ledger inside the private workspace payload preserves measurements and session-start limits after conversation deletion. Unknown dimensions remain absent, and no account balance or price estimate is inferred. Provider event IDs deduplicate repeated usage events where supplied. See `.env.example` and `docs/setup.md` for runtime configuration and `docs/test-report.md` for the distinction between deterministic tests, optional PostgreSQL verification and untested live/hardware paths.

Browser voice provider call identifiers and client/control heartbeats are saved privately in the session payload and stripped from bootstrap responses. Calls belong to their initiating user. Status requests can land on a different application worker, while a missing browser or sideband heartbeat ends the call. Failed provider hangups remain durable cleanup work. The worker must run for retrying hangups after an app restart and for deleting private originals after logical document deletion. Deleting an active browser conversation temporarily keeps only the private termination record until the provider confirms hangup; it disappears from the administrator's conversation list immediately.
