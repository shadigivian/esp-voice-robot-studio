import WebSocket from "ws";
import { createHash } from "node:crypto";
import type { Actor } from "./domain";
import { getService } from "./server/service";
import { AppError } from "./server/errors";
import { realtimeTranscriptEvent, realtimeUsageEvent } from "./voice-events";

interface ActiveCall {
  actor: Actor;
  sessionId: string;
  callId: string;
  socket: WebSocket;
  stop: (reason: string) => Promise<void>;
  lastClientSeen: number;
}
const runtime = globalThis as typeof globalThis & {
  robotBrowserCalls?: Map<string, ActiveCall>;
};
const calls = (runtime.robotBrowserCalls ??= new Map());
const provider = "https://api.openai.com/v1";
const headers = () => ({
  Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
});
async function hangup(callId: string) {
  const result = await fetch(
    `${provider}/realtime/calls/${encodeURIComponent(callId)}/hangup`,
    {
      method: "POST",
      headers: headers(),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    },
  );
  if (!result.ok && result.status !== 404)
    throw new AppError(
      "VOICE_STOP_FAILED",
      "Voice provider did not confirm call termination.",
      502,
    );
}
function assertOwner(actor: Actor, call: ActiveCall) {
  if (
    actor.userId !== call.actor.userId ||
    actor.workspaceId !== call.actor.workspaceId
  )
    throw new AppError("NOT_FOUND", "Voice session not found.", 404);
}
export async function startBrowserVoice(
  actor: Actor,
  input: Record<string, unknown>,
  requestSignal?: AbortSignal,
) {
  if (process.env.APP_MODE === "demo")
    throw new AppError(
      "DEMO_DISABLED",
      "Live voice is disabled in demo mode.",
      409,
    );
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_REALTIME_MODEL)
    throw new AppError(
      "SETUP_REQUIRED",
      "Configure the Realtime model and API key on the server.",
      503,
    );
  if (
    typeof input.sdp !== "string" ||
    input.sdp.length > 100_000 ||
    !input.sdp.startsWith("v=0")
  )
    throw new AppError("INVALID_SDP", "A valid browser SDP offer is required.");
  const service = getService();
  const { sessionId, context } = await service.startBrowserSession(actor, {
    deviceId: input.deviceId,
    preview: input.preview || "published",
  });
  const voice = context.character.voice || process.env.OPENAI_VOICE;
  if (!voice) {
    await service.endBrowserSession(actor, sessionId);
    throw new AppError(
      "SETUP_REQUIRED",
      "Select a supported voice for this device before starting.",
      503,
    );
  }
  let callId: string | undefined;
  const abort = () => {
    const active = calls.get(sessionId);
    if (active) void active.stop("request_aborted");
    else
      void service
        .endBrowserSession(actor, sessionId)
        .then(() => cleanupBrowserVoiceCalls(sessionId))
        .catch(() => {});
  };
  requestSignal?.addEventListener("abort", abort, { once: true });
  try {
    if (requestSignal?.aborted) {
      abort();
      throw new AppError(
        "REQUEST_ABORTED",
        "Voice startup was cancelled.",
        499,
      );
    }
    const form = new FormData();
    form.set("sdp", input.sdp);
    form.set(
      "session",
      JSON.stringify({
        type: "realtime",
        model: process.env.OPENAI_REALTIME_MODEL,
        instructions: context.instructions,
        output_modalities: ["audio"],
        tools: context.tools.map((tool) => ({
          ...tool,
          strict: true,
          parameters: {
            ...tool.parameters,
            required: tool.parameters.required || [],
          },
        })),
        tool_choice: "auto",
        audio: {
          input: {
            turn_detection: {
              type: "server_vad",
              create_response: false,
              interrupt_response: false,
            },
            ...(process.env.OPENAI_TRANSCRIPTION_MODEL
              ? {
                  transcription: {
                    model: process.env.OPENAI_TRANSCRIPTION_MODEL,
                  },
                }
              : {}),
          },
          output: { voice },
        },
      }),
    );
    const response = await fetch(`${provider}/realtime/calls`, {
      method: "POST",
      headers: {
        ...headers(),
        "OpenAI-Safety-Identifier": createHash("sha256")
          .update(actor.userId)
          .digest("hex"),
      },
      body: form,
      signal: requestSignal
        ? AbortSignal.any([requestSignal, AbortSignal.timeout(25_000)])
        : AbortSignal.timeout(25_000),
      redirect: "error",
    });
    if (!response.ok)
      throw new AppError(
        "PROVIDER_ERROR",
        `Voice provider returned HTTP ${response.status}. Check model and voice access.`,
        502,
      );
    callId = response.headers.get("location")?.split("/").pop();
    if (!callId || !/^[a-zA-Z0-9_-]+$/.test(callId))
      throw new AppError(
        "PROVIDER_ERROR",
        "The voice provider did not issue a call identifier.",
        502,
      );
    const sdp = await response.text();
    await service.registerBrowserCall(actor, sessionId, callId);
    await attachSideband(
      actor,
      sessionId,
      callId,
      context.limits.maxSessionSeconds,
    );
    return { sdp, sessionId };
  } catch (error) {
    if (callId)
      try {
        await hangup(callId);
        await service.confirmBrowserCallStopped(sessionId, callId);
      } catch {
        /* Durable worker cleanup retries the recorded call. */
      }
    await service.endBrowserSession(actor, sessionId).catch(() => {});
    throw error;
  } finally {
    requestSignal?.removeEventListener("abort", abort);
  }
}
async function attachSideband(
  actor: Actor,
  sessionId: string,
  callId: string,
  maximumSeconds: number,
) {
  const service = getService();
  const socket = new WebSocket(
    `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`,
    { headers: headers(), maxPayload: 2 * 1024 * 1024 },
  );
  let stopped = false,
    checking = false;
  const handled = new Set<string>();
  const send = (value: unknown) => {
    if (!stopped && socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(value));
  };
  const stop = async (_reason: string) => {
    if (stopped) return;
    stopped = true;
    clearInterval(watchdog);
    clearTimeout(deadline);
    calls.delete(sessionId);
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "response.cancel" }));
      socket.send(JSON.stringify({ type: "output_audio_buffer.clear" }));
    }
    socket.close();
    await service.endBrowserSession(actor, sessionId).catch(() => {});
    // Hangup terminates generation even after the browser loses its connection.
    try {
      await hangup(callId);
      await service.confirmBrowserCallStopped(sessionId, callId);
    } catch {
      setTimeout(() => {
        void cleanupBrowserVoiceCalls().catch(() => {});
      }, 1500).unref();
    }
  };
  const call: ActiveCall = {
    actor,
    sessionId,
    callId,
    socket,
    stop,
    lastClientSeen: Date.now(),
  };
  calls.set(sessionId, call);
  const watchdog = setInterval(async () => {
    if (checking || stopped) return;
    checking = true;
    try {
      await service.touchBrowserCall(actor, sessionId, "control");
    } catch {
      await stop("access_revoked");
    } finally {
      checking = false;
    }
  }, 1000);
  const deadline = setTimeout(
    () => {
      void stop("session_limit");
    },
    Math.min(maximumSeconds, 3600) * 1000,
  );
  socket.on("message", async (raw) => {
    if (stopped) return;
    let event: any;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }
    try {
      await service.checkBrowserSession(actor, sessionId);
      if (event.type === "response.function_call_arguments.done") {
        if (typeof event.call_id !== "string" || handled.has(event.call_id))
          return;
        if (
          handled.size >= 200 ||
          typeof event.arguments !== "string" ||
          event.arguments.length > 4096
        ) {
          await stop("tool_limit");
          return;
        }
        handled.add(event.call_id);
        let result: unknown;
        try {
          result = await service.browserTool(
            actor,
            sessionId,
            event.name,
            JSON.parse(event.arguments),
          );
        } catch {
          result = {
            status: "error",
            message:
              "This tool request is unavailable or outside the authorized session scope.",
          };
        }
        if (event.name === "end_session") {
          await stop("ended_by_user");
          return;
        }
        await service.checkBrowserSession(actor, sessionId);
        send({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: event.call_id,
            output: JSON.stringify(result),
          },
        });
        send({ type: "response.create" });
      } else if (event.type === "response.done" && event.response?.usage) {
        const measurement = realtimeUsageEvent(event);
        if (measurement)
          await service.browserEvent(actor, sessionId, measurement);
      } else if (
        event.type ===
          "conversation.item.input_audio_transcription.completed" ||
        event.type === "response.output_audio_transcript.done"
      ) {
        const transcript = realtimeTranscriptEvent(event);
        if (transcript)
          await service.browserEvent(actor, sessionId, transcript);
      } else if (event.type === "error") {
        await stop("provider_error");
      }
    } catch {
      await stop("session_invalid");
    }
  });
  socket.on("close", () => {
    void stop("provider_closed");
  });
  socket.on("error", () => {
    void stop("provider_error");
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new AppError(
              "VOICE_TIMEOUT",
              "Voice control connection timed out.",
              502,
            ),
          ),
        10_000,
      );
      socket.once("open", () => {
        clearTimeout(timer);
        send({
          type: "session.update",
          session: {
            type: "realtime",
            audio: {
              input: {
                turn_detection: {
                  type: "server_vad",
                  create_response: true,
                  interrupt_response: false,
                },
              },
            },
          },
        });
        resolve();
      });
      socket.once("error", () => {
        clearTimeout(timer);
        reject(
          new AppError(
            "VOICE_CONTROL_FAILED",
            "The server could not control the voice session.",
            502,
          ),
        );
      });
    });
  } catch (error) {
    await stop("startup_failed");
    throw error;
  }
}
export async function browserVoiceStatus(actor: Actor, sessionId: string) {
  const call = calls.get(sessionId);
  if (call) assertOwner(actor, call);
  try {
    await getService().touchBrowserCall(actor, sessionId, "client");
    if (call) call.lastClientSeen = Date.now();
    return { active: true };
  } catch {
    if (call) await call.stop("access_revoked");
    return { active: false };
  }
}
export async function stopBrowserVoice(actor: Actor, sessionId: string) {
  const call = calls.get(sessionId);
  if (call) {
    assertOwner(actor, call);
    await call.stop("manual_stop");
  } else await getService().endBrowserSession(actor, sessionId);
  await cleanupBrowserVoiceCalls(sessionId);
  // Manual interruption ends the session entirely. A restart always has clean context.
  return { active: false };
}
/** Worker also invokes this after app restarts. A failed hangup remains durable
 * pending work instead of being forgotten when the local socket map is gone. */
export async function cleanupBrowserVoiceCalls(onlySessionId?: string) {
  if (!process.env.OPENAI_API_KEY || process.env.APP_MODE === "demo") return;
  const service = getService();
  for (const pending of await service.browserCallsToStop(5, onlySessionId)) {
    try {
      await hangup(pending.callId);
      await service.confirmBrowserCallStopped(
        pending.sessionId,
        pending.callId,
      );
    } catch {
      /* The next worker cycle retries; never log provider call IDs. */
    }
  }
}
