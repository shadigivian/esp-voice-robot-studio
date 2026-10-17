import { authenticateRequest } from "@/lib/server/auth";
import { getService } from "@/lib/server/service";
import { AppError } from "@/lib/server/errors";
import { checkOrigin, failure, jsonBody } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  let end: (() => Promise<void>) | undefined;
  try {
    checkOrigin(request);
    const actor = await authenticateRequest(request);
    const service = getService();
    if (service.demo)
      throw new AppError(
        "DEMO_DISABLED",
        "Voice samples do not make paid calls in demo mode.",
        409,
      );
    if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_TTS_MODEL)
      throw new AppError(
        "SETUP_REQUIRED",
        "Configure OPENAI_TTS_MODEL and the provider key to play a real voice sample.",
        503,
      );
    const body = await jsonBody(request, 4096);
    await service.rateLimit(`voice_sample:${actor.userId}`, 5, 60_000);
    const { sessionId, context } = await service.startBrowserSession(actor, {
      deviceId: body.deviceId,
      preview: body.preview || "draft",
    });
    end = () => service.endBrowserSession(actor, sessionId);
    const voice = context.character.voice || process.env.OPENAI_VOICE;
    if (!voice)
      throw new AppError(
        "VOICE_REQUIRED",
        "Save a supported voice in this device draft first.",
      );
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_TTS_MODEL,
        voice,
        input:
          context.character.greeting.slice(0, 300) ||
          "Hello, I am your AI voice assistant.",
        response_format: "mp3",
      }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(25_000)]),
      redirect: "error",
    });
    if (!response.ok || !response.body)
      throw new AppError(
        "PROVIDER_ERROR",
        `Voice sample provider returned HTTP ${response.status}.`,
        502,
      );
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2_000_000) {
        await reader.cancel();
        throw new AppError(
          "AUDIO_LIMIT",
          "The voice sample exceeded its size limit.",
          502,
        );
      }
      chunks.push(value);
    }
    await service.checkBrowserSession(actor, sessionId);
    return new Response(new Uint8Array(Buffer.concat(chunks)), {
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return failure(error);
  } finally {
    if (end) await end().catch(() => {});
  }
}
