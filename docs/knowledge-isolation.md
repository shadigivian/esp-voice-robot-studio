# Private device knowledge

With AI_PROVIDER=qwen, approved reviewed text remains in the durable application database. Local keyword search applies the same workspace/device, revision, session and revocation filters; no OpenAI vector store or key is required for a new Qwen installation. This is keyword retrieval, not semantic search. Foreign-provider store/file identifiers require explicit migration and are not silently acknowledged as cleaned up. The provider-specific OpenAI indexing details below apply to OpenAI mode.

Each physical device owns its documents, facts, published source selection and private provider-store mapping. A shared character template does not share any of these resources. The server derives workspace/device identity from verified membership or a valid device credential; model tool parameters cannot select a tenant, file ID or vector store.

## Processing and publication

The upload route validates supported file types, signatures and configured size/page limits, stores the original privately, and extracts text using bounded parsing. The service stores extracted or manually entered text as a reviewable revision. Unreadable or failed extraction is reported honestly; OCR is not invented.

The supported lifecycle is `needs_review → approved → indexing → ready`, with failed states and retry. Upload/extraction happen before the review record is created. An empty extraction cannot be approved. A failed extraction cannot bypass approval by pressing retry. Editing creates a new revision and clears approval for that revision.

An indexing job captures the exact approved text and revision. The OpenAI provider uploads that corrected UTF-8 text as a `.txt` file, adds it to the device's private vector store with `source_id` and `revision` attributes, and checks real provider indexing status. Provider work is performed by the worker, outside the voice loop and database transaction. One indexing job per document revision is queued at a time; a lease prevents concurrent workers processing different jobs for the same device at once.

`readyRevision` and the live `activeRevision` are separate. Finishing indexing does not activate a new document or silently replace a published revision. The administrator selects ready sources in a draft and explicitly publishes them. Until then, a previous valid live revision remains available. An old job completing after an edit or deletion is marked superseded and cannot reactivate the document.

## Retrieval enforcement

`KnowledgeProvider` provides store creation, indexing, status, search and cleanup. `OpenAIKnowledgeProvider` uses a fixed `https://api.openai.com/v1` origin. Browser-provided URLs cannot receive the server key. Every device has an independently persisted vector-store mapping, kept server-only.

The common retrieval service applies these checks both before the provider request and after it returns:

1. The workspace/device pair must exist and belong to the authenticated actor or scoped credential.
2. A session, when supplied, must still be active, within its duration limit and on the current knowledge epoch.
3. A result must reference a document belonging to that exact device and included in its configuration's source selection.
4. Live retrieval requires an active, nondeleted document and a result revision equal to its published active revision. Draft preview uses its explicitly selected ready revision.
5. Provider file IDs must match the server's mapping for that revision. Unrecognized, superseded, cross-device and revoked results are dropped.

Only a bounded list of `{sourceId, revision, title, excerpt, score?}` leaves the service. No fabricated page number is attached. The implementation uses no retrieval cache, so there is no shared-character cache that can leak private content. If a cache is added, its key must include workspace, device, configuration version, knowledge epoch, revision set and request parameters; it must still perform the final authorization checks.

The tests intentionally return every fixture tenant's files from a badly scoped provider and verify that the application drops the forbidden results. They also delete a source while a provider search is in flight and verify the response is rejected before its excerpts reach the caller.

## Revocation and deletion

Disabling a source immediately removes its live binding and draft selection in the database. Deleting additionally removes stored extracted/review text, queues cleanup of known provider file revisions and supersedes pending jobs. Both operations increment the device knowledge epoch, end affected sessions and clear their stored message context. Rollback cannot restore a source whose access has been revoked; reactivation requires an explicit new source selection and publication.

The database access decision happens first. Provider index/file deletion is then retried by the worker, including cases where the provider is unavailable. Delayed cleanup cannot make an old provider search result accessible. Network responses or content already heard by a person cannot be erased; the application prevents that content being reused as context by ending the affected conversation. Voice adapters must stop generation, clear pending playback and create a fresh session.

## Tools and untrusted text

The only device tools are `search_device_knowledge(query)`, `get_verified_facts(query)`, `get_device_public_profile()` and `end_session(reason)`. They use strict argument validation and authenticated server scope. Arbitrary device IDs, workspace IDs, file IDs and vector-store IDs are not tool arguments. Document text cannot call management actions or enable other tools.

The context builder marks user messages and retrieved excerpts as untrusted data and instructs the model to ignore embedded instructions. That instruction supports the stronger authorization boundaries above; it is not the isolation mechanism. Strict mode requires active sources or administrator-verified facts for environment-specific claims. Hybrid mode allows relevant general explanations, while preserving that restriction for private business facts, prices, availability and safety claims.

The text playground retrieves with the same service and builds the same context as browser and ESP voice. Each test creates its own session, and draft preview does not update the published device. Shared templates, sessions on another device, previous visitors and browser telemetry cannot provide additional knowledge authority.

## Official provider references

Implementation was checked against the official [Retrieval guide](https://developers.openai.com/api/docs/guides/retrieval) and [Vector store search reference](https://developers.openai.com/api/reference/resources/vector_stores/methods/search). Account model access and live provider calls require explicit configured integration testing; deterministic provider fixtures do not establish account availability.
