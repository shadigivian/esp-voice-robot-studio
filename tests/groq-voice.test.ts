import test from "node:test";
import assert from "node:assert/strict";
import { ControlService } from "../lib/server/service";
import { MemoryStore } from "../lib/server/state";
import { LocalKnowledgeProvider } from "../lib/server/knowledge";
import { groqVoiceTurn } from "../lib/server/groq-voice";

async function fixture(work: (fixture: { service: ControlService; actor: Awaited<ReturnType<ControlService["createWorkspace"]>>; deviceId: string }) => Promise<void>) {
  const values = { AI_PROVIDER: "groq", GROQ_API_KEY: "fixture-groq-key", GROQ_TTS_URL: "http://127.0.0.1:8765/speech", SPEECH_BRIDGE_TOKEN: "fixture-bridge-token" };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  const service = new ControlService(new MemoryStore(), false, new LocalKnowledgeProvider());
  const actor = await service.createWorkspace("groq-voice", "Groq voice fixture");
  const created = await service.control(actor, { action: "create_device", name: "Fixture robot", mac: "02:10:20:30:40:51" });
  const runtime = globalThis as typeof globalThis & { robotControlService?: ControlService };
  const previousService = runtime.robotControlService, previousFetch = globalThis.fetch;
  runtime.robotControlService = service;
  try { await work({ service, actor, deviceId: created.deviceId as string }); }
  finally {
    globalThis.fetch = previousFetch; runtime.robotControlService = previousService;
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
const pcmResponse = () => new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "Content-Type": "audio/pcm", "x-audio-sample-rate": "24000" } });

test("Groq browser turn recognizes Persian, executes private facts in its authenticated session and returns 24k WAV", async () => fixture(async ({ actor, deviceId, service }) => {
  let chats = 0, speech = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/transcriptions")) return Response.json({ text: "سلام قیمت چقدر است؟" });
    if (String(url).endsWith("/completions")) {
      const body = JSON.parse(String(init!.body));
      assert.match(body.messages[0].content, /Fixture robot|دستیار|assistant/i);
      if (!chats++) return Response.json({ choices: [{ message: { role: "assistant", tool_calls: [{ id: "fact-call", type: "function", function: { name: "get_verified_facts", arguments: '{"query":"قیمت"}' } }] } }], usage: { prompt_tokens: 3, completion_tokens: 2 } });
      assert.equal(JSON.parse(body.messages.at(-1).content).status, "no_results");
      return Response.json({ choices: [{ message: { role: "assistant", content: "سلام، هنوز قیمت تأییدشده ندارم." } }], usage: { prompt_tokens: 7, completion_tokens: 5 } });
    }
    speech++; return pcmResponse();
  };
  const result = await groqVoiceTurn(actor, { deviceId, preview: "draft", audio: Buffer.alloc(3200).toString("base64") });
  assert.equal(result.audio.toString("ascii", 0, 4), "RIFF"); assert.equal(result.audio.readUInt32LE(24), 24000);
  assert.equal(result.transcript, "سلام، هنوز قیمت تأییدشده ندارم."); assert.equal(speech, 1);
  await assert.rejects(service.checkBrowserSession(actor, result.sessionId), /ended|active|session/i);
}));

test("Groq voice samples use configured Persian bridge without making a Groq transcription or chat request", async () => fixture(async ({ actor, deviceId }) => {
  const urls: string[] = [];
  globalThis.fetch = async (url, init) => {
    urls.push(String(url)); assert.equal((init!.headers as Record<string, string>).Authorization, "Bearer fixture-bridge-token");
    return pcmResponse();
  };
  const result = await groqVoiceTurn(actor, { deviceId, preview: "draft" }, undefined, true);
  assert.equal(result.audio.length, 48); assert.deepEqual(urls, ["http://127.0.0.1:8765/speech"]);
}));

test("Groq browser cancellation prevents text and speech after transcription completes", async () => fixture(async ({ actor, deviceId }) => {
  const controller = new AbortController(); let requests = 0;
  globalThis.fetch = async () => { requests++; controller.abort(); return Response.json({ text: "سلام" }); };
  await assert.rejects(groqVoiceTurn(actor, { deviceId, audio: Buffer.alloc(3200).toString("base64") }, controller.signal));
  assert.equal(requests, 1);
}));
