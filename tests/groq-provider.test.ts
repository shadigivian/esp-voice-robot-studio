import test from "node:test";
import assert from "node:assert/strict";
import {
  aiProvider,
  groqConfig,
  groqText,
  groqTranscribe,
  providerReadiness,
} from "../lib/server/ai-provider";
import { ControlService } from "../lib/server/service";
import { LocalKnowledgeProvider } from "../lib/server/knowledge";
import { MemoryStore } from "../lib/server/state";

async function environment(work: () => Promise<void>) {
  const values: Record<string, string | undefined> = {
    AI_PROVIDER: "groq",
    GROQ_API_KEY: "fixture-not-a-real-key",
    GROQ_TEXT_MODEL: "qwen/qwen3.8-27b",
    GROQ_STT_MODEL: undefined,
    GROQ_LANGUAGE: undefined,
    GROQ_TTS_URL: undefined,
    SPEECH_BRIDGE_TOKEN: undefined,
  };
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  const originalFetch = globalThis.fetch;
  for (const [key, value] of Object.entries(values))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  // Every test must explicitly supply an HTTP fixture; never call a real provider.
  globalThis.fetch = async () => {
    throw new Error("Unexpected network request");
  };
  try {
    await work();
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
}

test("Groq key enables text independently of DashScope and never claims realtime speech", async () =>
  environment(async () => {
    assert.equal(aiProvider(), "groq");
    assert.equal(groqConfig().baseUrl, "https://api.groq.com/openai/v1");
    assert.equal(providerReadiness().configured, true);
    assert.equal(providerReadiness().realtimeModel, null);
    assert.equal(providerReadiness().voiceSamples, false);
    process.env.GROQ_TTS_URL = "http://127.0.0.1:8765/speech";
    assert.equal(providerReadiness().voiceSamples, false);
    process.env.SPEECH_BRIDGE_TOKEN = "fixture-bridge-token";
    assert.equal(providerReadiness().voiceSamples, true);
    delete process.env.GROQ_API_KEY;
    assert.equal(providerReadiness().configured, false);
    assert.equal(providerReadiness().voiceSamples, false);
    await assert.rejects(
      groqText({
        instructions: "test",
        content: "test",
        tools: [],
        execute: async () => ({}),
      }),
      /GROQ_API_KEY/,
    );
  }));

test("Groq Qwen tools remain server scoped and accumulate only measured usage", async () =>
  environment(async () => {
    let requests = 0;
    let executed = 0;
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "https://api.groq.com/openai/v1/chat/completions");
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer fixture-not-a-real-key",
      );
      assert.equal(init?.redirect, "error");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, "qwen/qwen3.8-27b");
      assert.equal(body.reasoning_effort, "none");
      assert.equal(body.reasoning_format, "hidden");
      assert.equal(body.modalities, undefined);
      assert.equal(body.max_completion_tokens, 700);
      if (++requests === 1) {
        assert.equal(body.tools[0].function.name, "approved_fact");
        return Response.json({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "approved_fact",
                      arguments: '{"key":"hours"}',
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        });
      }
      assert.deepEqual(body.messages.at(-1), {
        role: "tool",
        tool_call_id: "call-1",
        content: '{"hours":"9-17"}',
      });
      return Response.json({
        choices: [
          { message: { role: "assistant", content: "ساعت کاری ۹ تا ۱۷ است." } },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 },
      });
    };
    const result = await groqText({
      instructions: "Reply in Persian with approved facts only.",
      content: "ساعت کاری؟",
      tools: [
        {
          type: "function",
          name: "approved_fact",
          description: "approved fact",
          parameters: { type: "object" },
        },
      ],
      execute: async (name, args) => {
        assert.equal(name, "approved_fact");
        assert.deepEqual(args, { key: "hours" });
        executed++;
        return { hours: "9-17" };
      },
    });
    assert.equal(result.answer, "ساعت کاری ۹ تا ۱۷ است.");
    assert.deepEqual(result.usage, { input_tokens: 30, output_tokens: 11 });
    assert.equal(executed, 1);
    assert.equal(requests, 2);
  }));

test("Groq rejects upstream diagnostics, unavailable tools and repeated IDs without executing them", async () =>
  environment(async () => {
    let executed = 0;
    const input = {
      instructions: "test",
      content: "test",
      tools: [
        {
          type: "function",
          name: "allowed",
          description: "test",
          parameters: {},
        },
      ],
      execute: async () => {
        executed++;
        return {};
      },
    };
    globalThis.fetch = async () =>
      new Response("secret upstream diagnostics", { status: 401 });
    await assert.rejects(
      groqText(input),
      (error: Error) =>
        /HTTP 401/.test(error.message) &&
        !error.message.includes("secret upstream"),
    );
    globalThis.fetch = async () =>
      Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              tool_calls: [
                {
                  id: "call",
                  type: "function",
                  function: { name: "foreign_workspace", arguments: "{}" },
                },
              ],
            },
          },
        ],
      });
    await assert.rejects(groqText(input), /invalid or unavailable tool/);
    assert.equal(executed, 0);
    globalThis.fetch = async () =>
      Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              tool_calls: [
                {
                  id: "duplicate",
                  type: "function",
                  function: { name: "allowed", arguments: "{}" },
                },
              ],
            },
          },
        ],
      });
    await assert.rejects(groqText(input), /invalid or unavailable tool/);
    assert.equal(executed, 1);
  }));

test("Groq transcription sends multipart Persian transcription and never translates audio", async () =>
  environment(async () => {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "https://api.groq.com/openai/v1/audio/transcriptions");
      assert.equal(new Headers(init?.headers).get("Content-Type"), null);
      const form = init?.body as FormData;
      assert.equal(form.get("language"), "fa");
      assert.equal(form.get("model"), "whisper-large-v3-turbo");
      assert.equal(form.get("response_format"), "json");
      assert.equal((form.get("file") as File).name, "speech.wav");
      return Response.json({ text: " سلام ربات " });
    };
    assert.deepEqual(
      await groqTranscribe(new Blob(["fixture WAV"], { type: "audio/wav" })),
      { text: "سلام ربات" },
    );
    await assert.rejects(groqTranscribe(new Blob([])), /short WAV/);
    globalThis.fetch = async () => Response.json({ text: "" });
    await assert.rejects(
      groqTranscribe(new Blob(["fixture WAV"])),
      /No usable speech/,
    );
  }));

test("Groq text playground uses real provider and local knowledge without a realtime model", async () =>
  environment(async () => {
    const service = new ControlService(
      new MemoryStore(),
      false,
      new LocalKnowledgeProvider(),
    );
    const actor = await service.createWorkspace("groq-fixture", "Groq fixture");
    const created = await service.control(actor, {
      action: "create_device",
      name: "Groq robot",
      mac: "02:10:20:30:40:90",
    });
    const initial = await service.bootstrap(actor);
    assert.equal(initial.integrations.provider, "groq");
    assert.equal(initial.integrations.knowledge, "local_keyword");
    assert.equal(initial.integrations.browserVoice, "push_to_talk");
    assert.equal(initial.integrations.model, null);
    globalThis.fetch = async (url) => {
      assert.equal(url, "https://api.groq.com/openai/v1/chat/completions");
      return Response.json({
        choices: [
          { message: { role: "assistant", content: "سلام، آماده‌ام." } },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 5 },
      });
    };
    const result = await service.control(actor, {
      action: "playground",
      deviceId: created.deviceId,
      query: "سلام",
      preview: "draft",
    });
    assert.equal(result.answer, "سلام، آماده‌ام.");
    assert.equal(result.demo, false);
    globalThis.fetch = async (url) => {
      assert.equal(
        url,
        "https://api.groq.com/openai/v1/models/qwen%2Fqwen3.8-27b",
      );
      return Response.json({ id: "qwen/qwen3.8-27b" });
    };
    const checked = await service.control(actor, {
      action: "integrations_test",
    });
    assert.equal(
      (checked.result as { status: string }).status,
      "model_visible",
    );
    assert.match(
      (checked.result as { message: string }).message,
      /Speech recognition.*not been tested/,
    );
  }));
