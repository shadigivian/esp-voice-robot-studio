import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import type { Actor } from "../domain";
import { realtimeTranscriptEvent, realtimeUsageEvent } from "../voice-events";
import { getService } from "./service";
import { aiProvider, qwenConfig, qwenVoice } from "./ai-provider";
import { AppError, assert } from "./errors";

export function pcmWav(pcm: Buffer, sampleRate = 24000) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(pcm.length + 36, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Bounded push-to-talk turns keep the provider connection and tool execution on
 * the server. Raw microphone PCM exists only for this request and is not stored. */
export async function qwenVoiceTurn(
  actor: Actor,
  input: Record<string, unknown>,
  signal?: AbortSignal,
  sample = false,
  connect: (url: URL, options: WebSocket.ClientOptions) => WebSocket = (
    url,
    options,
  ) => new WebSocket(url, options),
) {
  assert(
    aiProvider() === "qwen",
    "PROVIDER_MISMATCH",
    "Qwen voice is not selected.",
    409,
  );
  const service = getService();
  assert(
    !service.demo,
    "DEMO_DISABLED",
    "Live voice is disabled in demo mode.",
    409,
  );
  const config = qwenConfig();
  assert(
    config.key && config.realtimeEndpointConfigured,
    "SETUP_REQUIRED",
    "Configure DASHSCOPE_API_KEY and DASHSCOPE_WORKSPACE_ID (or QWEN_REALTIME_URL) for Qwen voice.",
    503,
  );
  let pcm: Buffer | undefined;
  if (!sample) {
    assert(
      typeof input.audio === "string" &&
        input.audio.length <= 640000 &&
        /^[A-Za-z0-9+/]*={0,2}$/.test(input.audio),
      "INVALID_AUDIO",
      "Send mono PCM16 audio at 16 kHz (maximum 15 seconds).",
    );
    pcm = Buffer.from(input.audio, "base64");
    assert(
      pcm.length >= 3200 && pcm.length <= 480000 && pcm.length % 2 === 0,
      "INVALID_AUDIO",
      "Record between 0.1 and 15 seconds of PCM16 audio.",
    );
  }
  await service.rateLimit(`qwen_voice:${actor.userId}`, 10, 60000);
  const { sessionId, context } = await service.startBrowserSession(actor, {
    deviceId: input.deviceId,
    preview: input.preview || "draft",
  });
  try {
    const result = await new Promise<{ audio: Buffer; transcript: string }>(
      (resolve, reject) => {
        const url = new URL(config.realtimeUrl);
        url.searchParams.set("model", config.realtimeModel);
        const socket = connect(url, {
          headers: { Authorization: `Bearer ${config.key}` },
          maxPayload: 2 * 1024 * 1024,
          handshakeTimeout: 10000,
          followRedirects: false,
        });
        const chunks: Buffer[] = [];
        const handled = new Set<string>();
        const completedResponses = new Set<string>();
        let bytes = 0,
          stopped = false,
          initialized = false,
          waitingCommit = false,
          rounds = 0;
        let transcript = "",
          pendingTools = 0,
          checking = false;
        const finish = (error?: unknown) => {
          if (stopped) return;
          stopped = true;
          clearTimeout(timer);
          clearInterval(watchdog);
          signal?.removeEventListener("abort", abort);
          if (socket.readyState === WebSocket.OPEN)
            socket.send(
              JSON.stringify({
                type: "session.finish",
                event_id: randomUUID(),
              }),
            );
          socket.terminate();
          if (error) reject(error);
          else if (!bytes || bytes % 2)
            reject(
              new AppError(
                "PROVIDER_ERROR",
                "Qwen returned missing or invalid PCM audio. Check model and voice access.",
                502,
              ),
            );
          else resolve({ audio: pcmWav(Buffer.concat(chunks)), transcript });
        };
        const abort = () =>
          finish(
            new AppError(
              "REQUEST_ABORTED",
              "Voice request was cancelled.",
              499,
            ),
          );
        signal?.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(
          () =>
            finish(
              new AppError(
                "VOICE_TIMEOUT",
                "Qwen voice timed out. Try a shorter recording.",
                504,
              ),
            ),
          45000,
        );
        const watchdog = setInterval(() => {
          if (checking || stopped) return;
          checking = true;
          void service
            .checkBrowserSession(actor, sessionId)
            .catch(finish)
            .finally(() => {
              checking = false;
            });
        }, 1000);
        const send = (value: Record<string, unknown>) => {
          if (!stopped && socket.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify({ event_id: randomUUID(), ...value }));
        };
        let queue = Promise.resolve();
        socket.on("message", (raw) => {
          // Serialize handlers so tool output precedes response.done continuation.
          queue = queue
            .then(async () => {
              if (stopped) return;
              const event = JSON.parse(raw.toString());
              if (event.type === "session.created") {
                send({
                  type: "session.update",
                  session: {
                    modalities: ["text", "audio"],
                    instructions: sample
                      ? `${context.instructions}\nFor this voice sample, immediately read this greeting aloud exactly without adding anything: ${context.character.greeting.slice(0, 300) || "سلام، من دستیار هوش مصنوعی شما هستم."}`
                      : context.instructions,
                    turn_detection: null,
                    audio: {
                      input: {
                        format: {
                          type: "pcm",
                          sample_rate: 16000,
                          sample_format: "s16le",
                          channels: 1,
                          packing: "interleaved",
                          channel_layout: "mono",
                        },
                      },
                      output: {
                        voice: qwenVoice(context.character.voice),
                        format: { type: "pcm", sample_rate: 24000 },
                      },
                    },
                    tools: sample
                      ? []
                      : context.tools.map(({ type, ...tool }) => ({
                          type,
                          function: tool,
                        })),
                    max_tokens: 700,
                  },
                });
              } else if (event.type === "session.updated" && !initialized) {
                initialized = true;
                await service.checkBrowserSession(actor, sessionId);
                if (pcm) {
                  for (let offset = 0; offset < pcm.length; offset += 3200)
                    send({
                      type: "input_audio_buffer.append",
                      audio: pcm
                        .subarray(offset, offset + 3200)
                        .toString("base64"),
                    });
                  waitingCommit = true;
                  send({ type: "input_audio_buffer.commit" });
                } else {
                  send({
                    type: "conversation.item.create",
                    item: {
                      type: "message",
                      role: "user",
                      content: [
                        {
                          type: "input_text",
                          text: `Read this greeting aloud exactly without adding anything: ${context.character.greeting.slice(0, 300) || "سلام، من دستیار هوش مصنوعی شما هستم."}`,
                        },
                      ],
                    },
                  });
                  send({ type: "response.create" });
                }
              } else if (
                event.type === "input_audio_buffer.committed" &&
                waitingCommit
              ) {
                waitingCommit = false;
                await service.checkBrowserSession(actor, sessionId);
                send({ type: "response.create" });
              } else if (event.type === "response.audio.delta") {
                assert(
                  typeof event.delta === "string" &&
                    event.delta.length <= 2000000,
                  "AUDIO_LIMIT",
                  "Qwen returned invalid audio.",
                  502,
                );
                const chunk = Buffer.from(event.delta, "base64");
                bytes += chunk.length;
                assert(
                  bytes <= 2000000,
                  "AUDIO_LIMIT",
                  "The voice response exceeded its size limit.",
                  502,
                );
                chunks.push(chunk);
              } else if (
                event.type === "response.function_call_arguments.done"
              ) {
                assert(
                  !sample &&
                    typeof event.call_id === "string" &&
                    !handled.has(event.call_id) &&
                    handled.size < 20 &&
                    typeof event.arguments === "string" &&
                    event.arguments.length <= 4096,
                  "TOOL_LIMIT",
                  "Qwen returned an invalid tool call.",
                  502,
                );
                handled.add(event.call_id);
                let output: unknown;
                if (event.name === "end_session") {
                  // A single turn ends after its final spoken response.
                  const args = JSON.parse(event.arguments);
                  assert(
                    typeof args.reason === "string" &&
                      args.reason.length <= 200,
                    "TOOL_DENIED",
                    "Invalid end-session arguments.",
                  );
                  output = { status: "ok", ended: true };
                } else
                  output = await service.browserTool(
                    actor,
                    sessionId,
                    event.name,
                    JSON.parse(event.arguments),
                  );
                await service.checkBrowserSession(actor, sessionId);
                send({
                  type: "conversation.item.create",
                  item: {
                    type: "function_call_output",
                    call_id: event.call_id,
                    output: JSON.stringify(output),
                  },
                });
                pendingTools++;
              } else if (event.type === "response.done") {
                const responseId = event.response?.id;
                if (typeof responseId === "string") {
                  if (completedResponses.has(responseId)) return;
                  completedResponses.add(responseId);
                }
                const measurement = realtimeUsageEvent(event);
                if (measurement)
                  await service.browserEvent(actor, sessionId, measurement);
                assert(
                  event.response?.status === "completed",
                  "PROVIDER_ERROR",
                  "Qwen could not complete the voice response.",
                  502,
                );
                if (pendingTools) {
                  assert(
                    ++rounds < 5,
                    "TOOL_LIMIT",
                    "Qwen exceeded the tool round limit.",
                    502,
                  );
                  pendingTools = 0;
                  send({ type: "response.create" });
                } else {
                  await service.checkBrowserSession(actor, sessionId);
                  finish();
                }
              } else if (
                event.type === "response.audio_transcript.done" ||
                event.type === "response.output_audio_transcript.done"
              ) {
                if (typeof event.transcript === "string")
                  transcript = event.transcript.slice(0, 10000);
                const message = realtimeTranscriptEvent(event);
                if (message)
                  await service.browserEvent(actor, sessionId, message);
              } else if (event.type === "error") {
                throw new AppError(
                  "PROVIDER_ERROR",
                  "Qwen rejected the voice request. Check endpoint, model and voice access.",
                  502,
                );
              }
            })
            .catch(finish);
        });
        socket.on("error", () =>
          finish(
            new AppError(
              "PROVIDER_ERROR",
              "The Qwen voice connection failed. Check the network and region.",
              502,
            ),
          ),
        );
        socket.on("close", () =>
          finish(
            new AppError(
              "PROVIDER_ERROR",
              "Qwen closed the voice connection before completion.",
              502,
            ),
          ),
        );
        if (signal?.aborted) abort();
      },
    );
    await service.checkBrowserSession(actor, sessionId);
    return { ...result, sessionId };
  } finally {
    await service.endBrowserSession(actor, sessionId).catch(() => {});
  }
}
