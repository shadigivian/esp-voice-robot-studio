import { randomUUID } from "node:crypto";
import type { Actor } from "../domain";
import { aiProvider } from "./ai-provider";
import { groqConfig, groqText, groqTranscribe } from "./groq-provider";
import { getService } from "./service";
import { AppError, assert } from "./errors";
import { pcmWave, synthesizeSpeech, SpeechError } from "../../integration/deno/groq-speech.mjs";

/** Push-to-talk keeps the Groq credential, private tools and speech bridge server-side. */
export async function groqVoiceTurn(actor: Actor, input: Record<string, unknown>, signal?: AbortSignal, sample = false) {
  assert(aiProvider() === "groq", "PROVIDER_MISMATCH", "Groq voice is not selected.", 409);
  const service = getService(), config = groqConfig();
  assert(!service.demo, "DEMO_DISABLED", "Live voice is disabled in demo mode.", 409);
  assert(config.key && config.ttsUrl && config.speechBridgeToken, "SETUP_REQUIRED", "Configure GROQ_API_KEY, GROQ_TTS_URL and SPEECH_BRIDGE_TOKEN for Persian voice.", 503);
  let pcm: Buffer | undefined;
  if (!sample) {
    assert(typeof input.audio === "string" && input.audio.length <= 640000 && /^[A-Za-z0-9+/]*={0,2}$/.test(input.audio), "INVALID_AUDIO", "Send mono PCM16 at 16 kHz (maximum 15 seconds).");
    pcm = Buffer.from(input.audio, "base64");
    assert(pcm.length >= 3200 && pcm.length <= 480000 && pcm.length % 2 === 0, "INVALID_AUDIO", "Record between 0.1 and 15 seconds of PCM16 audio.");
  }
  await service.rateLimit(`groq_voice:${actor.userId}`, 10, 60000);
  const { sessionId, context } = await service.startBrowserSession(actor, { deviceId: input.deviceId, preview: input.preview || "draft" });
  const cancellation = new AbortController();
  const requestSignal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(90000), ...(signal ? [signal] : [])]);
  let checking = false;
  const watchdog = setInterval(() => {
    if (checking) return;
    checking = true;
    void service.checkBrowserSession(actor, sessionId).catch((error: unknown) => cancellation.abort(error)).finally(() => { checking = false; });
  }, 1000);
  const check = async () => { requestSignal.throwIfAborted(); await service.checkBrowserSession(actor, sessionId); requestSignal.throwIfAborted(); };
  try {
    await check();
    let transcript = "", answer = context.character.greeting.slice(0, 300) || "سلام، من دستیار صوتی شما هستم.";
    if (pcm) {
      const recognized = await groqTranscribe(new Blob([new Uint8Array(pcmWave(pcm))], { type: "audio/wav" }), requestSignal);
      transcript = recognized.text;
      await check();
      await service.browserEvent(actor, sessionId, { type: "usage", provider: "groq-stt", model: config.sttModel, usage: { audio_input_seconds: pcm.length / 32000 }, final: true, eventId: randomUUID() });
      await service.browserEvent(actor, sessionId, { type: "message", role: "user", text: transcript });
      const result = await groqText({ instructions: context.instructions, content: transcript, tools: context.tools,
        signal: requestSignal, execute: async (name, args) => {
          await check();
          if (name === "end_session") {
            assert(args && typeof args === "object" && !Array.isArray(args) && Object.keys(args).length === 1 && "reason" in args && typeof args.reason === "string" && args.reason.length <= 200, "TOOL_DENIED", "Invalid end-session arguments.");
            return { status: "ok", ended: true };
          }
          const output = await service.browserTool(actor, sessionId, name, args); await check(); return output;
        },
      });
      answer = result.answer;
      await check();
      if (result.usage) await service.browserEvent(actor, sessionId, { type: "usage", provider: "groq-chat", model: config.textModel, usage: result.usage, final: true, eventId: randomUUID() });
    }
    await check();
    const audio = await synthesizeSpeech(config, answer, requestSignal);
    await check();
    await service.browserEvent(actor, sessionId, { type: "usage", provider: "speech-bridge", model: config.ttsVoice, usage: { audio_output_seconds: audio.length / 48000 }, final: true, eventId: randomUUID() });
    await service.browserEvent(actor, sessionId, { type: "message", role: "assistant", text: answer });
    return { audio: pcmWave(audio, 24000), transcript: answer, sessionId };
  } catch (error) {
    if (error instanceof SpeechError) throw new AppError(error.code, error.message, error.status);
    throw error;
  } finally {
    clearInterval(watchdog); cancellation.abort();
    await service.endBrowserSession(actor, sessionId).catch(() => {});
  }
}
