import { authenticateRequest } from "@/lib/server/auth";
import { checkOrigin, failure, jsonBody, reply } from "@/lib/http";
import {
  browserVoiceStatus,
  startBrowserVoice,
  stopBrowserVoice,
} from "@/lib/browser-voice";
import { AppError } from "@/lib/server/errors";
import { qwenVoiceTurn } from "@/lib/server/qwen-voice";
import { groqVoiceTurn } from "@/lib/server/groq-voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const actor = await authenticateRequest(request);
    const body = await jsonBody(request, 660_000);
    if (body.action === "qwen_turn" || body.action === "groq_turn") {
      const result = await (body.action === "groq_turn" ? groqVoiceTurn : qwenVoiceTurn)(actor, body, request.signal);
      return reply({
        audio: result.audio.toString("base64"),
        transcript: result.transcript,
        sessionId: result.sessionId,
      });
    }
    if (body.action === "interrupt" && typeof body.sessionId === "string")
      return reply(await stopBrowserVoice(actor, body.sessionId));
    return reply(await startBrowserVoice(actor, body, request.signal));
  } catch (error) {
    return failure(error);
  }
}
export async function GET(request: Request) {
  try {
    const actor = await authenticateRequest(request);
    const sessionId = new URL(request.url).searchParams.get("sessionId");
    if (!sessionId)
      throw new AppError("SESSION_REQUIRED", "A voice session is required.");
    return reply(await browserVoiceStatus(actor, sessionId));
  } catch (error) {
    return failure(error);
  }
}
export async function DELETE(request: Request) {
  try {
    checkOrigin(request);
    const actor = await authenticateRequest(request);
    const body = await jsonBody(request, 4096);
    if (typeof body.sessionId !== "string")
      throw new AppError("SESSION_REQUIRED", "A voice session is required.");
    return reply(await stopBrowserVoice(actor, body.sessionId));
  } catch (error) {
    return failure(error);
  }
}
