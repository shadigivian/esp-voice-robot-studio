import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { defaultConfig, type Actor, type Device } from "../lib/domain";
import { ControlService, normalizeMac } from "../lib/server/service";
import { MemoryStore } from "../lib/server/state";
import {
  DemoKnowledgeProvider,
  type KnowledgeProvider,
} from "../lib/server/knowledge";

async function fixture(
  demo = true,
  provider: KnowledgeProvider = new DemoKnowledgeProvider(),
) {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const store = new MemoryStore();
  const service = new ControlService(store, demo, provider, () => now);
  const owner = await service.createWorkspace("owner-user", "Workspace A");
  const other = await service.createWorkspace("other-user", "Workspace B");
  return {
    service,
    store,
    owner,
    other,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
async function create(
  service: ControlService,
  actor: Actor,
  mac = "02:11:22:33:44:55",
) {
  const result = await service.control(actor, {
    action: "create_device",
    name: "Test Robot",
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
    connectionId: "connection-one",
    nonce: "secure-random-nonce-one",
  };
  const displayed = await service.device({
    action: "bootstrap",
    ...proof,
    claimId: device.claim!.id,
  });
  await service.control(actor, {
    action: "verify_claim",
    deviceId: device.id,
    code: displayed.code,
  });
  const credential = await service.device({
    action: "claim_status",
    ...proof,
    claimId: displayed.claimId,
  });
  return { ...credential, proof, claimId: displayed.claimId } as {
    token: string;
    refreshToken: string;
    expiresAt: string;
    proof: typeof proof;
    claimId: string;
  };
}
async function addReady(
  service: ControlService,
  actor: Actor,
  deviceId: string,
  text: string,
) {
  const result = await service.control(actor, {
    action: "add_document",
    deviceId,
    title: "Private note",
    text,
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
  return documentId;
}
async function selectPublish(
  service: ControlService,
  actor: Actor,
  deviceId: string,
  documentId?: string,
) {
  if (documentId)
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

test("MAC canonicalization, unicast validation and no online status from registration", async () => {
  assert.equal(normalizeMac("02-AB-cd-01-02-03"), "02:AB:CD:01:02:03");
  assert.equal(normalizeMac("02abcd010203"), "02:AB:CD:01:02:03");
  for (const mac of [
    "FF:FF:FF:FF:FF:FF",
    "00:00:00:00:00:00",
    "01:22:33:44:55:66",
    "aa:not:mac",
  ])
    assert.throws(() => normalizeMac(mac));
  const { service, owner } = await fixture();
  const device = await create(service, owner);
  assert.equal(device.provisioning, "pending");
  assert.equal(device.connectivity, "unknown");
  assert.equal(device.lastSeen, null);
  const renamed = await service.control(owner, {
    action: "rename_device",
    deviceId: device.id,
    name: "Renamed device",
  });
  assert.equal(renamed.bootstrap.devices[0].name, "Renamed device");
  assert.equal(renamed.bootstrap.devices[0].mac, device.mac);
  await assert.rejects(
    service.control(owner, {
      action: "rename_device",
      deviceId: device.id,
      name: " ",
    }),
  );
  await assert.rejects(
    service.device({ action: "context", mac: device.mac }),
    /credential/,
  );
});

test("provisioned proof, connection binding, one-time claim and scoped short lived rotation", async () => {
  const { service, owner, advance } = await fixture();
  const device = await create(service, owner);
  await assert.rejects(
    service.device({
      action: "bootstrap",
      mac: device.mac,
      bootstrapSecret: "guessed",
      connectionId: "x",
      nonce: "x",
    }),
    /proof/,
  );
  const paired = await pair(service, owner, device);
  assert.equal(typeof paired.token, "string");
  await assert.rejects(
    service.device({
      action: "claim_status",
      ...paired.proof,
      connectionId: "different",
      claimId: paired.claimId,
    }),
    /connection/,
  );
  const replay = await service.device({
    action: "claim_status",
    ...paired.proof,
    claimId: paired.claimId,
  });
  assert.equal(replay.status, "consumed");
  assert.equal(replay.token, undefined);
  const refreshed = await service.device({
    action: "refresh",
    refreshToken: paired.refreshToken,
  });
  await assert.rejects(
    service.device({ action: "context", token: paired.token }),
    /expired or revoked/,
  );
  await assert.rejects(
    service.device({ action: "refresh", refreshToken: paired.refreshToken }),
    /expired or revoked/,
  );
  advance(900001);
  await assert.rejects(
    service.device({ action: "heartbeat", token: refreshed.token }),
    /expired or revoked/,
  );
});

test("five wrong claim attempts are persisted, locked, and do not roll back with API error", async () => {
  const { service, owner, store } = await fixture();
  const device = await create(service, owner);
  const bootstrapSecret = randomBytes(32).toString("hex");
  await service.provision(device.mac, bootstrapSecret);
  const displayed = await service.device({
    action: "bootstrap",
    mac: device.mac,
    bootstrapSecret,
    connectionId: "c",
    nonce: "n",
  });
  for (let attempt = 0; attempt < 5; attempt++)
    await assert.rejects(
      service.control(owner, {
        action: "verify_claim",
        deviceId: device.id,
        code: displayed.code === "000000" ? "111111" : "000000",
      }),
      /invalid|five attempts/,
    );
  const state = await store.transaction((state) => state.claims[0]);
  assert.equal(state.attempts, 5);
  assert.equal(state.status, "locked");
  await assert.rejects(
    service.control(owner, {
      action: "verify_claim",
      deviceId: device.id,
      code: displayed.code,
    }),
    /Wait/,
  );
});

test("expired claims and simultaneous ownership assignment have one winner", async () => {
  const { service, owner, other, advance } = await fixture();
  const first = await create(service, owner);
  const second = await create(service, other);
  const bootstrapSecret = randomBytes(32).toString("hex");
  await service.provision(first.mac, bootstrapSecret);
  const proof = {
    mac: first.mac,
    bootstrapSecret,
    connectionId: "c",
    nonce: "n",
  };
  const a = await service.device({
    action: "bootstrap",
    ...proof,
    claimId: first.claim!.id,
  });
  const b = await service.device({
    action: "bootstrap",
    ...proof,
    claimId: second.claim!.id,
  });
  const results = await Promise.allSettled([
    service.control(owner, {
      action: "verify_claim",
      deviceId: first.id,
      code: a.code,
    }),
    service.control(other, {
      action: "verify_claim",
      deviceId: second.id,
      code: b.code,
    }),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const expired = await create(service, owner, "02:11:22:33:44:99");
  await service.provision(expired.mac, bootstrapSecret);
  const c = await service.device({
    action: "bootstrap",
    ...proof,
    mac: expired.mac,
  });
  advance(300001);
  await assert.rejects(
    service.control(owner, {
      action: "verify_claim",
      deviceId: expired.id,
      code: c.code,
    }),
    /expired/,
  );
});

test("server membership, viewer permissions and device resource association resist forged IDs", async () => {
  const { service, owner, other, store } = await fixture();
  const device = await create(service, owner);
  const stranger = await create(service, other, "02:11:22:33:44:66");
  const documentId = await addReady(
    service,
    owner,
    device.id,
    "ONLY-A-PRIVATE-SECRET",
  );
  await assert.rejects(
    service.control(other, {
      action: "save_draft",
      deviceId: device.id,
      config: defaultConfig(),
    }),
    /not found/,
  );
  const forged = {
    ...other,
    workspaceId: owner.workspaceId,
    role: "owner" as const,
  };
  await assert.rejects(service.bootstrap(forged), /access denied/);
  await assert.rejects(
    service.control(other, {
      action: "edit_document",
      deviceId: stranger.id,
      documentId,
      text: "overwrite",
    }),
    /not found/,
  );
  await store.transaction((state) =>
    state.members.push({
      userId: "viewer",
      workspaceId: owner.workspaceId,
      role: "viewer",
    }),
  );
  const viewer: Actor = {
    userId: "viewer",
    workspaceId: owner.workspaceId,
    role: "owner",
  };
  assert.equal((await service.bootstrap(viewer)).user.role, "viewer");
  await assert.rejects(
    service.control(viewer, { action: "revoke_device", deviceId: device.id }),
    /Administrator/,
  );
});

test("template versions are independent snapshots, rollback cannot revive a deleted source", async () => {
  const { service, owner } = await fixture();
  const a = await create(service, owner);
  const b = await create(service, owner, "02:11:22:33:44:66");
  const character = defaultConfig().character;
  character.name = "Shared character";
  const saved = await service.control(owner, {
    action: "save_template",
    name: "Template",
    character,
  });
  const templateId = saved.templateId;
  for (const device of [a, b])
    await service.control(owner, {
      action: "apply_template",
      deviceId: device.id,
      templateId,
    });
  await service.control(owner, {
    action: "save_template",
    id: templateId,
    name: "Updated",
    character: { ...character, name: "Changed" },
  });
  let bootstrap = await service.bootstrap(owner);
  assert(
    bootstrap.devices.every(
      (device) => device.draft.character.name === "Shared character",
    ),
  );
  const documentId = await addReady(service, owner, a.id, "CONFIDENTIAL-A");
  await selectPublish(service, owner, a.id, documentId);
  await service.control(owner, {
    action: "delete_document",
    deviceId: a.id,
    documentId,
  });
  await service.control(owner, {
    action: "rollback",
    deviceId: a.id,
    version: 1,
  });
  bootstrap = await service.bootstrap(owner);
  assert.deepEqual(
    bootstrap.devices.find((device) => device.id === a.id)!.draft
      .activeSourceIds,
    [],
  );
  await service.control(owner, { action: "archive_template", templateId });
  assert.equal(
    (await service.bootstrap(owner)).devices.find(
      (device) => device.id === b.id,
    )!.draft.character.name,
    "Shared character",
  );
});

test("heartbeat expiry, capability gates and ACK distinguish desired and applied configuration", async () => {
  const { service, owner, advance } = await fixture();
  const device = await create(service, owner);
  const credential = await pair(service, owner, device);
  await selectPublish(service, owner, device.id);
  await assert.rejects(
    service.control(owner, {
      action: "command",
      deviceId: device.id,
      type: "reboot",
      payload: {},
    }),
    /capability/,
  );
  const heartbeat = await service.device({
    action: "heartbeat",
    token: credential.token,
    capabilities: ["reboot"],
    conversation: "idle",
  });
  const commands = heartbeat.commands as { id: string; type: string }[];
  let current = (await service.bootstrap(owner)).devices[0];
  assert.equal(current.connectivity, "online");
  assert.equal(current.appliedVersion, null);
  await assert.rejects(
    service.device({
      action: "ack",
      token: credential.token,
      commandId: commands[0].id,
      status: "applied",
      configVersion: 99,
    }),
    /version/,
  );
  await service.device({
    action: "ack",
    token: credential.token,
    commandId: commands[0].id,
    status: "applied",
    configVersion: 1,
  });
  await service.control(owner, {
    action: "command",
    deviceId: device.id,
    type: "reboot",
    payload: {},
  });
  advance(60001);
  current = (await service.bootstrap(owner)).devices[0];
  assert.equal(current.connectivity, "offline");
  assert.equal(current.appliedVersion, 1);
  assert.equal(current.commands.at(-1)!.status, "pending");
  advance(60001);
  assert.equal(
    (await service.bootstrap(owner)).devices[0].commands.at(-1)!.status,
    "failed",
  );
});

test("same character never shares retrieval; stale candidates, drafts and deleted data are filtered", async () => {
  const { service, owner } = await fixture();
  const a = await create(service, owner);
  const b = await create(service, owner, "02:11:22:33:44:66");
  const tokenA = await pair(service, owner, a);
  const tokenB = await pair(service, owner, b);
  const sourceA = await addReady(
    service,
    owner,
    a.id,
    "ALPHA-SECRET physical room A",
  );
  const sourceB = await addReady(
    service,
    owner,
    b.id,
    "BETA-SECRET physical room B",
  );
  await selectPublish(service, owner, a.id, sourceA);
  await selectPublish(service, owner, b.id, sourceB);
  const resultA = await service.device({
    action: "search",
    token: tokenA.token,
    query: "SECRET",
  });
  const resultB = await service.device({
    action: "search",
    token: tokenB.token,
    query: "SECRET",
    deviceId: a.id,
  });
  assert(JSON.stringify(resultA).includes("ALPHA-SECRET"));
  assert(!JSON.stringify(resultB).includes("ALPHA-SECRET"));
  assert(JSON.stringify(resultB).includes("BETA-SECRET"));
  const session = await service.device({
    action: "start_session",
    token: tokenA.token,
  });
  await service.control(owner, {
    action: "edit_document",
    deviceId: a.id,
    documentId: sourceA,
    text: "CORRECTED-SECRET",
  });
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
  const beforePublish = await service.device({
    action: "search",
    token: tokenA.token,
    query: "SECRET",
  });
  assert(JSON.stringify(beforePublish).includes("ALPHA-SECRET"));
  assert(!JSON.stringify(beforePublish).includes("CORRECTED-SECRET"));
  await service.control(owner, {
    action: "delete_document",
    deviceId: a.id,
    documentId: sourceA,
  });
  await assert.rejects(
    service.device({
      action: "context",
      token: tokenA.token,
      sessionId: session.sessionId,
    }),
    /no longer active/,
  );
  const after = await service.device({
    action: "search",
    token: tokenA.token,
    query: "SECRET",
  });
  assert.equal(after.status, "no_results");
});

test("session isolation, transcript opt-in, live revoke and device credential revocation", async () => {
  const { service, owner, store, advance } = await fixture();
  const device = await create(service, owner);
  const credential = await pair(service, owner, device);
  await selectPublish(service, owner, device.id);
  const previousKey = process.env.MANAGEMENT_ADAPTER_SECRET;
  process.env.MANAGEMENT_ADAPTER_SECRET = "trusted-test-adapter";
  try {
    const first = await service.device({
      action: "start_session",
      token: credential.token,
    });
    await assert.rejects(
      service.device({
        action: "server_event",
        token: credential.token,
        sessionId: first.sessionId,
        event: { type: "usage", usage: { input_tokens: 5 } },
      }),
      /Trusted/,
    );
    await service.device({
      action: "server_event",
      token: credential.token,
      adapterSecret: "trusted-test-adapter",
      sessionId: first.sessionId,
      event: { type: "message", role: "user", text: "MUST-NOT-PERSIST" },
    });
    assert(
      !JSON.stringify(
        await store.transaction((state) => state.sessions),
      ).includes("MUST-NOT-PERSIST"),
    );
    await service.control(owner, {
      action: "save_privacy",
      deviceId: device.id,
      storeTranscripts: true,
      retentionDays: 1,
    });
    const second = await service.device({
      action: "start_session",
      token: credential.token,
    });
    assert.notEqual(second.sessionId, first.sessionId);
    await service.device({
      action: "server_event",
      token: credential.token,
      adapterSecret: "trusted-test-adapter",
      sessionId: second.sessionId,
      event: { type: "message", role: "user", text: "OPTED-IN-TEXT" },
    });
    let sessions = (await service.bootstrap(owner)).sessions;
    assert(
      sessions
        .find((row) => row.id === second.sessionId)!
        .messages.some((row) => row.text === "OPTED-IN-TEXT"),
    );
    assert.equal(
      sessions.find((row) => row.id === first.sessionId)!.messages.length,
      0,
    );
    advance(86400001);
    await service.cleanupRetention();
    sessions = (await service.bootstrap(owner)).sessions;
    assert(sessions.every((row) => row.messages.length === 0));
    await service.control(owner, {
      action: "revoke_device",
      deviceId: device.id,
    });
    await assert.rejects(
      service.device({
        action: "refresh",
        refreshToken: credential.refreshToken,
      }),
      /revoked/,
    );
    await assert.rejects(
      service.device({ action: "heartbeat", token: credential.token }),
      /revoked/,
    );
  } finally {
    if (previousKey === undefined) delete process.env.MANAGEMENT_ADAPTER_SECRET;
    else process.env.MANAGEMENT_ADAPTER_SECRET = previousKey;
  }
});

test("explicit demo has isolated workspaces, three labeled devices and no paid browser sessions", async () => {
  const { service, owner, other } = await fixture();
  await service.seedDemo(owner);
  const snapshot = await service.bootstrap(owner);
  assert.equal(snapshot.devices.length, 3);
  assert(snapshot.devices.every((device) => device.demo));
  assert.equal((await service.bootstrap(other)).devices.length, 0);
  await assert.rejects(
    service.startBrowserSession(owner, {
      deviceId: snapshot.devices[0].id,
      preview: "published",
    }),
    /demo mode/,
  );
  const result = await service.control(owner, {
    action: "playground",
    deviceId: snapshot.devices[0].id,
    query: "ساعات",
    preview: "published",
  });
  assert.match(String(result.answer), /^\[Demo\]/);
  assert.equal(
    (await service.bootstrap(owner)).devices[0].connectivity,
    "unknown",
  );
});

test("minute requests cannot evict hourly rate counters and windows expire independently", async () => {
  const { service, advance } = await fixture();
  await service.rateLimit("hourly", 1, 3600000);
  await service.rateLimit("minute", 10, 60000);
  await assert.rejects(service.rateLimit("hourly", 1, 3600000), /Too many/);
  advance(60001);
  await service.rateLimit("minute", 10, 60000);
  await assert.rejects(service.rateLimit("hourly", 1, 3600000), /Too many/);
  advance(3600000);
  await service.rateLimit("hourly", 1, 3600000);
});
