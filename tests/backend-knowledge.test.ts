import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ControlService } from "../lib/server/service";
import { MemoryStore } from "../lib/server/state";
import type { Actor, Device, Source } from "../lib/domain";
import type { KnowledgeProvider } from "../lib/server/knowledge";
import {
  realtimeTranscriptEvent,
  realtimeUsageEvent,
} from "../lib/voice-events";

class FixtureProvider implements KnowledgeProvider {
  files = new Map<
    string,
    {
      storeId: string;
      text: string;
      meta: { documentId: string; revision: number; title: string };
    }
  >();
  removed: string[] = [];
  indexCalls: string[] = [];
  onSearch?: () => Promise<void>;
  onIndex?: () => Promise<void>;
  async createStore(id: string) {
    return `store-${id}`;
  }
  async index(
    storeId: string,
    text: string,
    meta: { documentId: string; revision: number; title: string },
  ) {
    this.indexCalls.push(text);
    if (this.onIndex) await this.onIndex();
    const id = `file-${this.files.size + 1}`;
    this.files.set(id, { storeId, text, meta });
    return id;
  }
  async status() {
    return "ready" as const;
  }
  // Deliberately return all tenants and revisions: the application must filter.
  async search(): Promise<(Source & { fileId: string })[]> {
    const result = [...this.files].map(([fileId, file]) => ({
      sourceId: file.meta.documentId,
      revision: file.meta.revision,
      title: file.meta.title,
      excerpt: file.text,
      fileId,
    }));
    if (this.onSearch) await this.onSearch();
    return result;
  }
  async remove(_store: string, file: string) {
    this.removed.push(file);
    this.files.delete(file);
  }
}
async function fixture() {
  const provider = new FixtureProvider();
  const store = new MemoryStore();
  const service = new ControlService(store, false, provider);
  const owner = await service.createWorkspace("owner", "Production fixture");
  const other = await service.createWorkspace("other", "Other fixture");
  return { provider, store, service, owner, other };
}
async function create(service: ControlService, actor: Actor, mac: string) {
  const result = await service.control(actor, {
    action: "create_device",
    name: "Fixture",
    mac,
  });
  return result.bootstrap.devices.find((row) => row.id === result.deviceId)!;
}
async function pair(service: ControlService, actor: Actor, device: Device) {
  const bootstrapSecret = randomBytes(32).toString("hex");
  await service.provision(device.mac, bootstrapSecret);
  const proof = {
    mac: device.mac,
    bootstrapSecret,
    connectionId: "secure-connection",
    nonce: "random-nonce-12345",
  };
  const code = await service.device({ action: "bootstrap", ...proof });
  await service.control(actor, {
    action: "verify_claim",
    deviceId: device.id,
    code: code.code,
  });
  return service.device({
    action: "claim_status",
    ...proof,
    claimId: code.claimId,
  });
}
async function ready(
  service: ControlService,
  actor: Actor,
  deviceId: string,
  body: string,
) {
  const result = await service.control(actor, {
    action: "add_document",
    deviceId,
    title: "Private",
    text: body,
  });
  const documentId = result.documentId as string;
  await service.control(actor, {
    action: "approve_document",
    deviceId,
    documentId,
  });
  await service.control(actor, {
    action: "index_document",
    deviceId,
    documentId,
  });
  await service.processJobs();
  return documentId;
}
async function publish(
  service: ControlService,
  actor: Actor,
  deviceId: string,
  documentId: string,
) {
  await service.control(actor, {
    action: "toggle_document",
    deviceId,
    documentId,
    active: true,
  });
  await service.control(actor, {
    action: "publish",
    deviceId,
    confirmKnowledge: true,
  });
}

test("corrected approved text is indexed once; provider output is bound to device and active revision", async () => {
  const { service, provider, owner, other } = await fixture();
  const a = await create(service, owner, "02:10:10:10:10:10");
  const b = await create(service, other, "02:20:20:20:20:20");
  const credentials = await pair(service, owner, a);
  const sourceA = await ready(service, owner, a.id, "PRIVATE-A-ORIGINAL");
  const sourceB = await ready(service, other, b.id, "PRIVATE-B-SECRET");
  await publish(service, owner, a.id, sourceA);
  await publish(service, other, b.id, sourceB);
  let result = await service.device({
    action: "search",
    token: credentials.token,
    query: "private",
  });
  assert(JSON.stringify(result).includes("PRIVATE-A-ORIGINAL"));
  assert(!JSON.stringify(result).includes("PRIVATE-B-SECRET"));
  const openSession = await service.device({
    action: "start_session",
    token: credentials.token,
  });
  await service.control(owner, {
    action: "edit_document",
    deviceId: a.id,
    documentId: sourceA,
    text: "PRIVATE-A-CORRECTED",
  });
  await assert.rejects(
    service.control(owner, {
      action: "index_document",
      deviceId: a.id,
      documentId: sourceA,
    }),
    /Approve/,
  );
  await service.control(owner, {
    action: "approve_document",
    deviceId: a.id,
    documentId: sourceA,
  });
  await service.control(owner, {
    action: "index_document",
    deviceId: a.id,
    documentId: sourceA,
  });
  await service.control(owner, {
    action: "index_document",
    deviceId: a.id,
    documentId: sourceA,
  });
  await service.processJobs();
  assert.equal(
    provider.indexCalls.filter((text) => text === "PRIVATE-A-CORRECTED").length,
    1,
  );
  result = await service.device({
    action: "search",
    token: credentials.token,
    query: "private",
  });
  assert(JSON.stringify(result).includes("ORIGINAL"));
  assert(!JSON.stringify(result).includes("CORRECTED"));
  await publish(service, owner, a.id, sourceA);
  result = await service.device({
    action: "search",
    token: credentials.token,
    query: "private",
  });
  assert(JSON.stringify(result).includes("CORRECTED"));
  assert(!JSON.stringify(result).includes("ORIGINAL"));
  await assert.rejects(
    service.device({
      action: "context",
      token: credentials.token,
      sessionId: openSession.sessionId,
    }),
    /no longer active/,
  );
  const bootstrap = JSON.stringify(await service.bootstrap(owner));
  assert(!bootstrap.includes('"providerFileId"'));
  assert(!bootstrap.includes('"activeFileId"'));
  assert(!bootstrap.includes("store-"));
});

test("deletion during provider search blocks the in-flight result before returning content", async () => {
  const { service, provider, owner } = await fixture();
  const a = await create(service, owner, "02:10:10:10:10:10");
  const credential = await pair(service, owner, a);
  const source = await ready(
    service,
    owner,
    a.id,
    "DO-NOT-LEAK-AFTER-REVOCATION",
  );
  await publish(service, owner, a.id, source);
  provider.onSearch = async () => {
    await service.control(owner, {
      action: "delete_document",
      deviceId: a.id,
      documentId: source,
    });
  };
  await assert.rejects(
    service.device({
      action: "search",
      token: credential.token,
      query: "secret",
    }),
    /Knowledge access changed/,
  );
  await service.processJobs();
  assert(provider.removed.length > 0);
  assert.equal(provider.files.size, 0);
});

test("a stale indexing completion never resurrects a deleted or superseded revision", async () => {
  const { service, provider, owner, store } = await fixture();
  const device = await create(service, owner, "02:10:10:10:10:10");
  const result = await service.control(owner, {
    action: "add_document",
    deviceId: device.id,
    title: "Delete race",
    text: "sensitive original",
  });
  const documentId = result.documentId as string;
  await service.control(owner, {
    action: "approve_document",
    deviceId: device.id,
    documentId,
  });
  await service.control(owner, {
    action: "index_document",
    deviceId: device.id,
    documentId,
  });
  let release!: () => void;
  let entered!: () => void;
  const indexEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  provider.onIndex = async () => {
    entered();
    await gate;
  };
  const processing = service.processJobs(1);
  await indexEntered;
  await service.control(owner, {
    action: "delete_document",
    deviceId: device.id,
    documentId,
  });
  release();
  await processing;
  const doc = (await service.bootstrap(owner)).devices[0].documents[0];
  assert.equal(doc.status, "deleted");
  assert.equal(doc.active, false);
  assert.equal(doc.readyRevision, undefined);
  assert(provider.removed.length > 0);
  assert(
    !JSON.stringify(await store.transaction((state) => state.jobs)).includes(
      "sensitive original",
    ),
  );
});

test("failed extraction cannot bypass text review and approval", async () => {
  const { service, owner } = await fixture();
  const device = await create(service, owner, "02:10:10:10:10:10");
  const failed = await service.control(owner, {
    action: "add_document",
    deviceId: device.id,
    title: "Scanned",
    text: "",
    extractionError: "No readable text",
  });
  await assert.rejects(
    service.control(owner, {
      action: "index_document",
      deviceId: device.id,
      documentId: failed.documentId,
    }),
    /Approve/,
  );
});

test("browser test sessions pin role, share retrieval and close on revocation; administrative tools are denied", async () => {
  const { service, owner, other } = await fixture();
  const device = await create(service, owner, "02:10:10:10:10:10");
  const source = await ready(service, owner, device.id, "BROWSER-PRIVATE");
  await publish(service, owner, device.id, source);
  const started = await service.startBrowserSession(owner, {
    deviceId: device.id,
    preview: "published",
  });
  assert(started.context.instructions.includes("untrusted DATA"));
  await assert.rejects(
    service.browserTool(owner, started.sessionId, "delete_document", {}),
    /not available/,
  );
  await assert.rejects(
    service.browserTool(owner, started.sessionId, "search_device_knowledge", {
      query: "private",
      deviceId: "other-device",
    }),
  );
  await assert.rejects(
    service.checkBrowserSession(other, started.sessionId),
    /not found/,
  );
  const result = await service.browserTool(
    owner,
    started.sessionId,
    "search_device_knowledge",
    { query: "private" },
  );
  assert(JSON.stringify(result).includes("BROWSER-PRIVATE"));
  const current = (await service.bootstrap(owner)).devices[0];
  const next = structuredClone(current.draft);
  next.character.name = "New name for next visitor";
  await service.control(owner, {
    action: "save_draft",
    deviceId: device.id,
    config: next,
  });
  await service.control(owner, { action: "publish", deviceId: device.id });
  const pinned = await service.checkBrowserSession(owner, started.sessionId);
  assert.equal(
    pinned.context.character.name,
    current.published!.character.name,
  );
  await service.control(owner, {
    action: "toggle_document",
    deviceId: device.id,
    documentId: source,
    active: false,
  });
  await assert.rejects(
    service.checkBrowserSession(owner, started.sessionId),
    /no longer active/,
  );
});

test("trusted usage deduplicates event IDs; unknown dimensions remain unavailable; privacy stops storage", async () => {
  const { service, owner } = await fixture();
  const device = await create(service, owner, "02:10:10:10:10:10");
  await service.control(owner, { action: "publish", deviceId: device.id });
  const session = await service.startBrowserSession(owner, {
    deviceId: device.id,
    preview: "published",
  });
  await service.browserEvent(owner, session.sessionId, {
    type: "usage",
    eventId: "response-1",
    usage: { input_tokens: 12, output_tokens: 7, voice_session_seconds: 30 },
  });
  await service.browserEvent(owner, session.sessionId, {
    type: "usage",
    eventId: "response-1",
    usage: { input_tokens: 12, output_tokens: 7 },
  });
  let snapshot = await service.bootstrap(owner);
  assert.deepEqual(snapshot.stats.usage, {
    input_tokens: 12,
    output_tokens: 7,
    voice_session_seconds: 30,
  });
  assert.equal("balance" in snapshot.stats.usage!, false);
  await service.browserEvent(owner, session.sessionId, {
    type: "message",
    role: "user",
    text: "NOT-STORED",
  });
  snapshot = await service.bootstrap(owner);
  assert.equal(snapshot.sessions[0].messages.length, 0);
  await service.endBrowserSession(owner, session.sessionId);
  await assert.rejects(
    service.browserEvent(owner, session.sessionId, {
      type: "usage",
      usage: { input_tokens: 999 },
    }),
    /no longer active/,
  );
});

test("provider response usage is a per-response delta and transcript fields match service validation", async () => {
  const { service, owner } = await fixture();
  const device = await create(service, owner, "02:10:10:10:10:10");
  await service.control(owner, { action: "publish", deviceId: device.id });
  await service.control(owner, {
    action: "save_privacy",
    deviceId: device.id,
    storeTranscripts: true,
    retentionDays: 1,
  });
  const session = await service.startBrowserSession(owner, {
    deviceId: device.id,
    preview: "published",
  });
  const first = realtimeUsageEvent({
    type: "response.done",
    response: { id: "r1", usage: { input_tokens: 10, output_tokens: 5 } },
  });
  const second = realtimeUsageEvent({
    type: "response.done",
    response: { id: "r2", usage: { input_tokens: 20, output_tokens: 7 } },
  });
  await service.browserEvent(owner, session.sessionId, first);
  await service.browserEvent(owner, session.sessionId, second);
  await service.browserEvent(owner, session.sessionId, second);
  const transcript = realtimeTranscriptEvent({
    type: "response.output_audio_transcript.done",
    transcript: "Verified spoken answer",
  });
  await service.browserEvent(owner, session.sessionId, transcript);
  const snapshot = await service.bootstrap(owner);
  assert.deepEqual(snapshot.stats.usage, {
    input_tokens: 30,
    output_tokens: 12,
  });
  assert.equal(snapshot.sessions[0].messages[0].text, "Verified spoken answer");
});

test("deleting a conversation cannot reset measured usage or daily session limits", async () => {
  const { service, owner } = await fixture();
  const device = await create(service, owner, "02:10:10:10:10:10");
  await service.control(owner, { action: "publish", deviceId: device.id });
  const session = await service.startBrowserSession(owner, {
    deviceId: device.id,
    preview: "published",
  });
  await service.browserEvent(owner, session.sessionId, {
    type: "usage",
    eventId: "r1",
    usage: { input_tokens: 12 },
  });
  await service.endBrowserSession(owner, session.sessionId);
  await service.control(owner, {
    action: "delete_session",
    sessionId: session.sessionId,
  });
  assert.equal((await service.bootstrap(owner)).stats.usage!.input_tokens, 12);
  const oldTokens = process.env.MAX_DEVICE_TOKENS_PER_DAY;
  const oldStarts = process.env.MAX_DEVICE_SESSIONS_PER_DAY;
  try {
    process.env.MAX_DEVICE_TOKENS_PER_DAY = "10";
    await assert.rejects(
      service.startBrowserSession(owner, {
        deviceId: device.id,
        preview: "published",
      }),
      /token budget/,
    );
    process.env.MAX_DEVICE_TOKENS_PER_DAY = "10000";
    process.env.MAX_DEVICE_SESSIONS_PER_DAY = "1";
    await assert.rejects(
      service.startBrowserSession(owner, {
        deviceId: device.id,
        preview: "published",
      }),
      /daily session limit/,
    );
  } finally {
    if (oldTokens === undefined) delete process.env.MAX_DEVICE_TOKENS_PER_DAY;
    else process.env.MAX_DEVICE_TOKENS_PER_DAY = oldTokens;
    if (oldStarts === undefined) delete process.env.MAX_DEVICE_SESSIONS_PER_DAY;
    else process.env.MAX_DEVICE_SESSIONS_PER_DAY = oldStarts;
  }
});

test("browser call cleanup survives local map loss, session deletion and a late provider response", async () => {
  const { service, owner, store } = await fixture();
  const device = await create(service, owner, "02:10:10:10:10:10");
  await service.control(owner, { action: "publish", deviceId: device.id });
  const opened = await service.startBrowserSession(owner, {
    deviceId: device.id,
    preview: "published",
  });
  await store.transaction((state) =>
    state.members.push({
      userId: "second-admin",
      workspaceId: owner.workspaceId,
      role: "admin",
    }),
  );
  const peer: Actor = {
    userId: "second-admin",
    workspaceId: owner.workspaceId,
    role: "admin",
  };
  await assert.rejects(
    service.checkBrowserSession(peer, opened.sessionId),
    /not found/,
  );
  await service.registerBrowserCall(
    owner,
    opened.sessionId,
    "rtc_private_test_id",
  );
  assert(
    !JSON.stringify(await service.bootstrap(owner)).includes(
      "rtc_private_test_id",
    ),
  );
  await service.touchBrowserCall(owner, opened.sessionId, "client");
  await store.transaction((state) => {
    state.sessions.find(
      (row) => row.id === opened.sessionId,
    )!.browserControlSeen = new Date(Date.now() - 16000).toISOString();
  });
  await assert.rejects(
    service.touchBrowserCall(owner, opened.sessionId, "client"),
    /expired/,
  );
  assert.deepEqual(await service.browserCallsToStop(), [
    { sessionId: opened.sessionId, callId: "rtc_private_test_id" },
  ]);
  await service.control(owner, {
    action: "delete_session",
    sessionId: opened.sessionId,
  });
  assert.equal((await service.bootstrap(owner)).sessions.length, 0);
  assert.equal((await service.browserCallsToStop()).length, 1);
  await service.confirmBrowserCallStopped(
    opened.sessionId,
    "rtc_private_test_id",
  );
  assert.equal((await service.browserCallsToStop()).length, 0);
  const pending = await service.startBrowserSession(owner, {
    deviceId: device.id,
    preview: "published",
  });
  await service.control(owner, {
    action: "delete_session",
    sessionId: pending.sessionId,
  });
  await assert.rejects(
    service.registerBrowserCall(
      owner,
      pending.sessionId,
      "rtc_late_provider_call",
    ),
    /revoked while/,
  );
  assert.deepEqual(await service.browserCallsToStop(), [
    { sessionId: pending.sessionId, callId: "rtc_late_provider_call" },
  ]);
  await service.confirmBrowserCallStopped(
    pending.sessionId,
    "rtc_late_provider_call",
  );
});

test("document deletion can be retried for disk cleanup without reactivating sources", async () => {
  const { service, owner, store } = await fixture();
  const device = await create(service, owner, "02:10:10:10:10:10");
  const documentId = await ready(service, owner, device.id, "Private text");
  await service.control(owner, {
    action: "delete_document",
    deviceId: device.id,
    documentId,
  });
  const jobs = (await store.transaction((state) => state.jobs)).length;
  await service.control(owner, {
    action: "delete_document",
    deviceId: device.id,
    documentId,
  });
  assert.equal((await store.transaction((state) => state.jobs)).length, jobs);
  await assert.rejects(
    service.authorizeDocument(owner, device.id, documentId),
    /not found/,
  );
});
