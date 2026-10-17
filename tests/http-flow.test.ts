import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const base = process.env.TEST_APP_BASE_URL;
test(
  "HTTP: demo login, device lifecycle, reviewed knowledge, files, privacy and workspace isolation",
  {
    skip: !base
      ? "Set TEST_APP_BASE_URL to an explicitly started demo server."
      : false,
  },
  async () => {
    const origin = new URL(base!).origin;
    async function call(
      endpoint: string,
      body?: unknown,
      cookie = "",
      method = body ? "POST" : "GET",
    ) {
      const response = await fetch(`${origin}${endpoint}`, {
        method,
        headers: {
          Origin: origin,
          ...(cookie ? { cookie } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const result = await response.json();
      return { response, result };
    }
    const mode = await call("/api/auth");
    assert.equal(
      mode.result.data.demo,
      true,
      "This test must never run against production.",
    );
    assert.equal((await call("/api/control")).response.status, 401);
    const login = await call("/api/auth", { demo: true });
    assert.equal(login.response.status, 200);
    const cookie = login.response.headers.get("set-cookie")!.split(";")[0];
    assert.match(login.response.headers.get("set-cookie")!, /HttpOnly/i);
    const second = await call("/api/auth", { demo: true });
    const cookieB = second.response.headers.get("set-cookie")!.split(";")[0];
    const initial = await call("/api/control", undefined, cookie);
    assert.equal(initial.result.data.devices.length, 3);
    const secondInitial = await call("/api/control", undefined, cookieB);
    assert.notEqual(
      secondInitial.result.data.workspace.id,
      initial.result.data.workspace.id,
    );
    const invalid = await call(
      "/api/control",
      { action: "create_device", name: "Invalid", mac: "not-a-mac" },
      cookie,
    );
    assert.equal(invalid.response.status, 400);
    const created = await call(
      "/api/control",
      {
        action: "create_device",
        name: "HTTP fixture",
        mac: `02:${randomBytes(5).toString("hex").match(/.{2}/g)!.join(":")}`,
      },
      cookie,
    );
    assert.equal(created.response.status, 200);
    const deviceId = created.result.data.deviceId;
    let device = created.result.data.bootstrap.devices.find(
      (device: { id: string }) => device.id === deviceId,
    );
    assert.equal(device.connectivity, "unknown");
    assert.equal(device.provisioning, "pending");
    assert.equal(
      (
        await call(
          "/api/control",
          { action: "save_draft", deviceId, config: device.draft },
          cookieB,
        )
      ).response.status,
      404,
    );
    const evil = await fetch(`${origin}/api/control`, {
      method: "POST",
      headers: {
        cookie,
        Origin: "https://other.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "create_device",
        name: "bad",
        mac: "02:00:00:00:00:01",
      }),
    });
    assert.equal(evil.status, 403);
    const text = "عبارت خصوصی HTTP fixture unique-bridge-91";
    const form = new FormData();
    form.set("file", new Blob([text], { type: "text/plain" }), "private.txt");
    const uploaded = await fetch(`${origin}/api/upload?deviceId=${deviceId}`, {
      method: "POST",
      headers: { cookie, Origin: origin },
      body: form,
    });
    assert.equal(uploaded.status, 201);
    const upload = (await uploaded.json()).data;
    const documentId = upload.documentId;
    assert.ok(documentId);
    const source = await fetch(
      `${origin}/api/files?deviceId=${deviceId}&documentId=${documentId}`,
      { headers: { cookie } },
    );
    assert.equal(source.status, 200);
    assert.equal(await source.text(), text);
    const forbidden = await fetch(
      `${origin}/api/files?deviceId=${deviceId}&documentId=${documentId}`,
      { headers: { cookie: cookieB } },
    );
    assert.equal(forbidden.status, 404);
    for (const action of ["approve_document", "index_document"])
      assert.equal(
        (await call("/api/control", { action, deviceId, documentId }, cookie))
          .response.status,
        200,
      );
    const selected = await call(
      "/api/control",
      { action: "toggle_document", deviceId, documentId, active: true },
      cookie,
    );
    assert.equal(selected.response.status, 200);
    const published = await call(
      "/api/control",
      { action: "publish", deviceId },
      cookie,
    );
    assert.equal(published.response.status, 200);
    device = published.result.data.bootstrap.devices.find(
      (device: { id: string }) => device.id === deviceId,
    );
    assert.equal(device.configVersion, 1);
    assert.equal(device.appliedVersion, null);
    const answer = await call(
      "/api/control",
      {
        action: "playground",
        deviceId,
        preview: "published",
        query: "unique-bridge-91",
      },
      cookie,
    );
    assert.equal(answer.response.status, 200);
    assert.match(answer.result.data.answer, /unique-bridge-91/);
    assert.equal(answer.result.data.sources[0].sourceId, documentId);
    const session = answer.result.data.bootstrap.sessions.find(
      (session: { id: string }) => session.id === answer.result.data.sessionId,
    );
    assert.equal(session.transcriptStored, false);
    assert.deepEqual(session.messages, []);
    const voice = await call(
      "/api/voice",
      { deviceId, preview: "published", sdp: "v=0" },
      cookie,
    );
    assert.equal(voice.response.status, 409);
    assert.equal(
      (
        await call(
          "/api/control",
          { action: "delete_document", deviceId, documentId },
          cookie,
        )
      ).response.status,
      200,
    );
    const deletedFile = await fetch(
      `${origin}/api/files?deviceId=${deviceId}&documentId=${documentId}`,
      { headers: { cookie } },
    );
    assert.equal(deletedFile.status, 404);
    const after = await call(
      "/api/control",
      {
        action: "playground",
        deviceId,
        preview: "published",
        query: "unique-bridge-91",
      },
      cookie,
    );
    assert.equal(after.response.status, 200);
    assert.deepEqual(after.result.data.sources, []);
    await call("/api/auth", undefined, cookie, "DELETE");
    assert.equal(
      (await call("/api/control", undefined, cookie)).response.status,
      403,
    );
    await call("/api/auth", undefined, cookieB, "DELETE");
  },
);
