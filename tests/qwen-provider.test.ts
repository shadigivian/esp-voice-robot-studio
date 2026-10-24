import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import {
  aiProvider,
  providerReadiness,
  qwenConfig,
  qwenText,
  qwenVoice,
} from "../lib/server/ai-provider";
import { LocalKnowledgeProvider } from "../lib/server/knowledge";
import { ControlService } from "../lib/server/service";
import { MemoryStore } from "../lib/server/state";
import { qwenVoiceTurn } from "../lib/server/qwen-voice";

async function environment(work: () => Promise<void>) {
  const values = {
    AI_PROVIDER: "qwen",
    VOICE_PROVIDER: undefined,
    DASHSCOPE_API_KEY: "fixture-not-a-real-key",
    DASHSCOPE_WORKSPACE_ID: "fixture",
    DASHSCOPE_REGION: "ap-southeast-1",
    QWEN_BASE_URL: undefined,
    QWEN_REALTIME_URL: undefined,
  };
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(values))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  try {
    await work();
  } finally {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
}
async function fixture() {
  const store = new MemoryStore();
  const service = new ControlService(
    store,
    false,
    new LocalKnowledgeProvider(),
  );
  const actor = await service.createWorkspace("qwen-fixture", "Qwen fixture");
  const created = await service.control(actor, {
    action: "create_device",
    name: "Fixture robot",
    mac: "02:10:20:30:40:50",
  });
  const deviceId = created.deviceId as string;
  const runtime = globalThis as typeof globalThis & {
    robotControlService?: ControlService;
  };
  const previous = runtime.robotControlService;
  runtime.robotControlService = service;
  return {
    actor,
    store,
    service,
    deviceId,
    restore: () => {
      runtime.robotControlService = previous;
    },
  };
}
async function voiceServer(
  handler: (event: any, socket: WebSocket) => Promise<void> | void,
) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  server.on("connection", (socket, request) => {
    assert.equal(
      request.headers.authorization,
      "Bearer fixture-not-a-real-key",
    );
    socket.send(JSON.stringify({ type: "session.created" }));
    let queue = Promise.resolve();
    socket.on("message", (raw) => {
      queue = queue.then(() => handler(JSON.parse(raw.toString()), socket));
    });
  });
  return {
    connect: (_url: URL, options: WebSocket.ClientOptions) =>
      new WebSocket(`ws://127.0.0.1:${address.port}`, options),
    close: async () => {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
const send = (socket: WebSocket, value: unknown) =>
  socket.send(JSON.stringify(value));
const audio = Buffer.alloc(3200).toString("base64");

test("Qwen readiness requires workspace endpoints and never relies on an OpenAI key", async () =>
  environment(async () => {
    assert.equal(aiProvider(), "qwen");
    assert.equal(providerReadiness().configured, true);
    assert.equal(
      qwenConfig().baseUrl,
      "https://fixture.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    );
    delete process.env.DASHSCOPE_WORKSPACE_ID;
    assert.equal(providerReadiness().configured, false);
    process.env.QWEN_BASE_URL = "https://example.test/compatible-mode/v1";
    process.env.QWEN_REALTIME_URL = "wss://example.test/api-ws/v1/realtime";
    assert.equal(providerReadiness().configured, true);
    process.env.QWEN_REALTIME_URL = "ws://example.test/unsafe";
    assert.throws(() => qwenConfig(), /secure URLs/);
  }));

test("local knowledge refuses cleanup of another provider's remote file mappings", async () => {
  const provider = new LocalKnowledgeProvider();
  await assert.rejects(
    provider.index("vs_old_openai", "approved", {
      documentId: "doc",
      revision: 1,
    }),
    /another provider/,
  );
  await assert.rejects(
    provider.remove("vs_old_openai", "file-old"),
    /another provider/,
  );
  await assert.rejects(
    provider.status("local-device", "file-old"),
    /another provider/,
  );
});

test("published Qwen voice takes priority and legacy OpenAI voices fall back", () => {
  const original = process.env.QWEN_VOICE;
  process.env.QWEN_VOICE = "Tina";
  try {
    assert.equal(qwenVoice("Ethan"), "Ethan");
    assert.equal(qwenVoice("marin"), "Tina");
  } finally {
    if (original === undefined) delete process.env.QWEN_VOICE;
    else process.env.QWEN_VOICE = original;
  }
});

test("Qwen text uses documented schema, executes scoped tools and sums measured usage", async () =>
  environment(async () => {
    const originalFetch = globalThis.fetch;
    const requests: any[] = [];
    globalThis.fetch = async (url, options) => {
      assert.match(
        String(url),
        /fixture\.ap-southeast-1\.maas\.aliyuncs\.com\/compatible-mode\/v1\/chat\/completions$/,
      );
      const request = JSON.parse(options!.body as string);
      requests.push(request);
      assert.equal(request.reasoning_effort, "none");
      assert.deepEqual(request.modalities, ["text"]);
      assert.equal(request.tools[0].function.name, "get_device_public_profile");
      return Response.json(
        requests.length === 1
          ? {
              choices: [
                {
                  message: {
                    role: "assistant",
                    tool_calls: [
                      {
                        id: "call-1",
                        type: "function",
                        function: {
                          name: "get_device_public_profile",
                          arguments: "{}",
                        },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 8, completion_tokens: 2 },
            }
          : {
              choices: [{ message: { role: "assistant", content: "سلام" } }],
              usage: { prompt_tokens: 12, completion_tokens: 3 },
            },
      );
    };
    try {
      const result = await qwenText({
        instructions: "Scoped",
        content: "Hello",
        tools: [
          {
            type: "function",
            name: "get_device_public_profile",
            description: "Read current profile",
            parameters: { type: "object" },
          },
        ],
        execute: async (name, args) => {
          assert.equal(name, "get_device_public_profile");
          assert.deepEqual(args, {});
          return { name: "Current robot" };
        },
      });
      assert.equal(result.answer, "سلام");
      assert.deepEqual(result.usage, { input_tokens: 20, output_tokens: 5 });
      assert.equal(requests[1].messages.at(-1).tool_call_id, "call-1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }));

test("Qwen text rejects provider errors and unauthorized tools without executing them", async () =>
  environment(async () => {
    const originalFetch = globalThis.fetch;
    try {
      const input = {
        instructions: "Scoped",
        content: "Hello",
        tools: [],
        execute: async () => {
          throw new Error("must not execute");
        },
      };
      globalThis.fetch = async () =>
        new Response("secret provider diagnostics", { status: 401 });
      await assert.rejects(qwenText(input), /HTTP 401/);
      globalThis.fetch = async () =>
        Response.json({
          choices: [
            {
              message: {
                role: "assistant",
                tool_calls: [
                  {
                    id: "forbidden",
                    type: "function",
                    function: { name: "other_device", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        });
      await assert.rejects(qwenText(input), /invalid or unavailable tool/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }));

test("Qwen voice turn sends PCM, controls tools on the server, returns WAV and honors transcript privacy", async () =>
  environment(async () => {
    const fixtureData = await fixture();
    let response = 0,
      appended = 0,
      committed = false;
    const server = await voiceServer((event, socket) => {
      if (event.type === "session.update") {
        assert.equal(event.session.audio.input.format.sample_rate, 16000);
        assert.equal(event.session.audio.output.format.sample_rate, 24000);
        assert.equal(
          event.session.tools[0].function.name,
          "search_device_knowledge",
        );
        assert.equal(event.session.tool_choice, undefined);
        send(socket, { type: "session.updated" });
      } else if (event.type === "input_audio_buffer.append")
        appended += Buffer.from(event.audio, "base64").length;
      else if (event.type === "input_audio_buffer.commit") {
        committed = true;
        setTimeout(
          () => send(socket, { type: "input_audio_buffer.committed" }),
          10,
        );
      } else if (event.type === "response.create") {
        assert(committed);
        response++;
        if (response === 1) {
          send(socket, {
            type: "response.function_call_arguments.done",
            call_id: "profile-1",
            name: "get_device_public_profile",
            arguments: "{}",
          });
          send(socket, {
            type: "response.done",
            response: {
              id: "r1",
              status: "completed",
              usage: { input_tokens: 4, output_tokens: 1 },
            },
          });
          send(socket, {
            type: "response.done",
            response: {
              id: "r1",
              status: "completed",
              usage: { input_tokens: 4, output_tokens: 1 },
            },
          });
        } else {
          send(socket, {
            type: "response.audio.delta",
            delta: Buffer.alloc(480).toString("base64"),
          });
          send(socket, {
            type: "response.audio_transcript.done",
            transcript: "سلام، من دستیار شما هستم.",
          });
          send(socket, {
            type: "response.done",
            response: {
              id: "r2",
              status: "completed",
              usage: { input_tokens: 3, output_tokens: 2 },
            },
          });
        }
      } else if (event.type === "conversation.item.create") {
        assert.equal(event.item.type, "function_call_output");
        assert.equal(
          JSON.parse(event.item.output).profile.name,
          "Fixture robot",
        );
      }
    });
    try {
      const result = await qwenVoiceTurn(
        fixtureData.actor,
        { deviceId: fixtureData.deviceId, audio },
        undefined,
        false,
        server.connect,
      );
      assert.equal(appended, 3200);
      assert.equal(response, 2);
      assert.equal(result.audio.toString("ascii", 0, 4), "RIFF");
      assert.equal(result.audio.readUInt32LE(24), 24000);
      assert.equal(result.audio.length, 524);
      assert.match(result.transcript, /سلام/);
      const snapshot = await fixtureData.service.bootstrap(fixtureData.actor);
      assert.deepEqual(snapshot.sessions[0].usage, {
        input_tokens: 7,
        output_tokens: 3,
      });
      assert.deepEqual(snapshot.sessions[0].messages, []);
      assert.equal(snapshot.sessions[0].status, "ended");
      assert.equal(snapshot.integrations.knowledge, "local_keyword");
      assert(
        !JSON.stringify(snapshot.integrations).includes(
          "fixture-not-a-real-key",
        ),
      );
    } finally {
      await server.close();
      fixtureData.restore();
    }
  }));

test("Qwen voice sample uses saved greeting text input and no microphone", async () =>
  environment(async () => {
    const data = await fixture();
    const snapshot = await data.service.bootstrap(data.actor);
    const config = snapshot.devices[0].draft;
    config.character.greeting = "سلام دوست من";
    config.character.voice = "Tina";
    await data.service.control(data.actor, {
      action: "save_draft",
      deviceId: data.deviceId,
      config,
    });
    const server = await voiceServer((event, socket) => {
      assert.notEqual(event.type, "input_audio_buffer.append");
      if (event.type === "session.update") {
        assert.match(event.session.instructions, /سلام دوست من/);
        assert.deepEqual(event.session.tools, []);
        send(socket, { type: "session.updated" });
      } else if (event.type === "conversation.item.create") {
        assert.equal(event.item.role, "user");
        assert.equal(event.item.content[0].type, "input_text");
        assert.match(event.item.content[0].text, /سلام دوست من/);
      } else if (event.type === "response.create") {
        send(socket, {
          type: "response.audio.delta",
          delta: Buffer.alloc(480).toString("base64"),
        });
        send(socket, {
          type: "response.done",
          response: { status: "completed" },
        });
      }
    });
    try {
      const result = await qwenVoiceTurn(
        data.actor,
        { deviceId: data.deviceId },
        undefined,
        true,
        server.connect,
      );
      assert.equal(result.audio.length, 524);
    } finally {
      await server.close();
      data.restore();
    }
  }));

test("Qwen voice rejects invalid audio, provider errors and aborted requests and closes sessions", async () =>
  environment(async () => {
    const data = await fixture();
    const server = await voiceServer((event, socket) => {
      if (event.type === "session.update")
        send(socket, {
          type: "error",
          error: { message: "private diagnostic" },
        });
    });
    try {
      await assert.rejects(
        qwenVoiceTurn(
          data.actor,
          { deviceId: data.deviceId, audio: "not base64" },
          undefined,
          false,
          server.connect,
        ),
        /PCM16/,
      );
      await assert.rejects(
        qwenVoiceTurn(
          data.actor,
          { deviceId: data.deviceId, audio },
          undefined,
          false,
          server.connect,
        ),
        /rejected the voice request/,
      );
      const abort = new AbortController();
      abort.abort();
      await assert.rejects(
        qwenVoiceTurn(
          data.actor,
          { deviceId: data.deviceId, audio },
          abort.signal,
          false,
          server.connect,
        ),
        /cancelled/,
      );
      const snapshot = await data.service.bootstrap(data.actor);
      assert(snapshot.sessions.every((session) => session.status !== "active"));
    } finally {
      await server.close();
      data.restore();
    }
  }));

test("Qwen voice rechecks revocation before returning provider audio", async () =>
  environment(async () => {
    const data = await fixture();
    const server = await voiceServer(async (event, socket) => {
      if (event.type === "session.update")
        send(socket, { type: "session.updated" });
      else if (event.type === "input_audio_buffer.commit")
        send(socket, { type: "input_audio_buffer.committed" });
      else if (event.type === "response.create") {
        await data.store.transaction((state) => {
          state.devices.find((device) => device.id === data.deviceId)!
            .knowledgeEpoch++;
        });
        send(socket, {
          type: "response.audio.delta",
          delta: Buffer.alloc(480).toString("base64"),
        });
        send(socket, {
          type: "response.done",
          response: { status: "completed" },
        });
      }
    });
    try {
      await assert.rejects(
        qwenVoiceTurn(
          data.actor,
          { deviceId: data.deviceId, audio },
          undefined,
          false,
          server.connect,
        ),
        /revoked|changed|clean session/i,
      );
    } finally {
      await server.close();
      data.restore();
    }
  }));

test("local Qwen retrieval indexes approved text and filters workspace, revision and source revocation", async () =>
  environment(async () => {
    const data = await fixture();
    try {
      async function source(
        actor: typeof data.actor,
        deviceId: string,
        value: string,
      ) {
        const added = await data.service.control(actor, {
          action: "add_document",
          deviceId,
          title: "راهنما",
          text: value,
        });
        const documentId = added.documentId as string;
        for (const action of ["approve_document", "index_document"])
          await data.service.control(actor, { action, deviceId, documentId });
        assert.equal((await data.service.processJobs()).ready, 1);
        await data.service.control(actor, {
          action: "toggle_document",
          deviceId,
          documentId,
          active: true,
        });
        return documentId;
      }
      const ownSource = await source(
        data.actor,
        data.deviceId,
        "قیمت کیک: ۱۰۰ تومان",
      );
      const other = await data.service.createWorkspace(
        "other",
        "Other workspace",
      );
      const created = await data.service.control(other, {
        action: "create_device",
        name: "Other robot",
        mac: "02:10:20:30:40:60",
      });
      await source(
        other,
        created.deviceId as string,
        "قیمت کیک: PRIVATE-OTHER-WORKSPACE",
      );
      const opened = await data.service.startBrowserSession(data.actor, {
        deviceId: data.deviceId,
        preview: "draft",
      });
      const result = await data.service.browserTool(
        data.actor,
        opened.sessionId,
        "search_device_knowledge",
        { query: "قيمت كيك" },
      );
      assert(JSON.stringify(result).includes("۱۰۰"));
      assert(!JSON.stringify(result).includes("PRIVATE-OTHER"));
      await data.service.control(data.actor, {
        action: "edit_document",
        deviceId: data.deviceId,
        documentId: ownSource,
        text: "قیمت کیک: UNAPPROVED",
      });
      const current = await data.service.browserTool(
        data.actor,
        opened.sessionId,
        "search_device_knowledge",
        { query: "کیک" },
      );
      assert(!JSON.stringify(current).includes("UNAPPROVED"));
      await data.service.control(data.actor, {
        action: "toggle_document",
        deviceId: data.deviceId,
        documentId: ownSource,
        active: false,
      });
      await assert.rejects(
        data.service.browserTool(
          data.actor,
          opened.sessionId,
          "search_device_knowledge",
          { query: "کیک" },
        ),
        /revoked|clean session/i,
      );
    } finally {
      data.restore();
    }
  }));
