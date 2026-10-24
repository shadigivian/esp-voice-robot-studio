import { AppError, assert } from "./errors";

/** The Groq key and upstream URL are server-owned; neither comes from a client. */
export function groqConfig() {
  return {
    key: process.env.GROQ_API_KEY,
    baseUrl: "https://api.groq.com/openai/v1",
    textModel: process.env.GROQ_TEXT_MODEL || "qwen/qwen3.8-27b",
    sttModel: process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo",
    transcriptionModel: process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo",
    language: process.env.GROQ_LANGUAGE || "fa",
    ttsUrl: process.env.GROQ_TTS_URL,
    ttsVoice: process.env.GROQ_TTS_VOICE || "fa_IR-amir-medium",
    speechBridgeToken: process.env.SPEECH_BRIDGE_TOKEN,
  };
}

export interface GroqTextInput {
  instructions: string;
  content: string;
  tools: {
    type: string;
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }[];
  execute: (name: string, args: unknown) => Promise<unknown>;
  history?: { role: "user" | "assistant"; content: string }[];
  signal?: AbortSignal;
}

/** Bounded tool calls execute through the caller's authenticated session only. */
export async function groqText(input: GroqTextInput) {
  const config = groqConfig();
  assert(
    config.key,
    "SETUP_REQUIRED",
    "Configure GROQ_API_KEY to use Groq.",
    503,
  );
  const messages: Record<string, unknown>[] = [
    { role: "system", content: input.instructions },
    ...(input.history || []).slice(-12),
    { role: "user", content: input.content },
  ];
  const usage: Record<string, number> = {};
  const timeout = AbortSignal.timeout(45_000);
  const signal = input.signal
    ? AbortSignal.any([timeout, input.signal])
    : timeout;
  const names = new Set(input.tools.map((tool) => tool.name));
  const handled = new Set<string>();
  for (let round = 0; round < 5; round++) {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.textModel,
        messages,
        ...(input.tools.length
          ? {
              tools: input.tools.map(({ type, ...tool }) => ({
                type,
                function: tool,
              })),
              tool_choice: "auto",
            }
          : {}),
        ...(config.textModel.startsWith("qwen/")
          ? { reasoning_effort: "none", reasoning_format: "hidden" }
          : {}),
        max_completion_tokens: 700,
        stream: false,
      }),
      signal,
      redirect: "error",
    });
    if (!response.ok)
      throw new AppError(
        "PROVIDER_ERROR",
        `Groq text provider returned HTTP ${response.status}. Check the key, model access and account limits.`,
        502,
      );
    const result = await response.json();
    for (const [target, source] of [
      ["input_tokens", "prompt_tokens"],
      ["output_tokens", "completion_tokens"],
    ]) {
      const value = result.usage?.[source];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0)
        usage[target] = (usage[target] || 0) + value;
    }
    const message = result.choices?.[0]?.message;
    assert(
      message && message.role === "assistant",
      "PROVIDER_ERROR",
      "Groq returned an invalid assistant response.",
      502,
    );
    const calls = message.tool_calls;
    assert(
      calls === undefined || calls === null || Array.isArray(calls),
      "PROVIDER_ERROR",
      "Groq returned invalid tool calls.",
      502,
    );
    if (!calls?.length) {
      assert(
        typeof message.content === "string" && message.content.trim(),
        "PROVIDER_ERROR",
        "Groq returned no text. Check model compatibility.",
        502,
      );
      return {
        answer: message.content as string,
        usage: Object.keys(usage).length ? usage : null,
      };
    }
    assert(
      calls.length <= 8 && handled.size + calls.length <= 20,
      "TOOL_LIMIT",
      "Groq exceeded the tool call limit.",
      502,
    );
    messages.push({
      role: "assistant",
      content: message.content || null,
      tool_calls: calls,
    });
    for (const call of calls) {
      assert(
        call &&
          typeof call.id === "string" &&
          call.id.length > 0 &&
          call.id.length <= 200 &&
          !handled.has(call.id) &&
          call.type === "function" &&
          names.has(call.function?.name) &&
          typeof call.function?.arguments === "string" &&
          call.function.arguments.length <= 4096,
        "TOOL_DENIED",
        "Groq returned an invalid or unavailable tool call.",
        502,
      );
      handled.add(call.id);
      let args: unknown;
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        throw new AppError(
          "PROVIDER_ERROR",
          "Groq returned invalid tool arguments.",
          502,
        );
      }
      signal.throwIfAborted();
      const output = await input.execute(call.function.name, args);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(output),
      });
    }
  }
  throw new AppError(
    "TOOL_LIMIT",
    "Groq did not finish within the tool round limit.",
    502,
  );
}

/** Transcriptions preserve Persian; /audio/translations would translate to English. */
export async function groqTranscribe(audio: Blob, signal?: AbortSignal) {
  const config = groqConfig();
  assert(
    config.key,
    "SETUP_REQUIRED",
    "Configure GROQ_API_KEY to transcribe speech.",
    503,
  );
  assert(
    audio.size > 0 && audio.size <= 2_000_000,
    "INVALID_AUDIO",
    "Send a short WAV recording of at most 2 MB.",
    400,
  );
  const form = new FormData();
  form.set("file", audio, "speech.wav");
  form.set("model", config.sttModel);
  form.set("language", config.language);
  form.set("response_format", "json");
  form.set("temperature", "0");
  const timeout = AbortSignal.timeout(30_000);
  const response = await fetch(`${config.baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.key}` },
    body: form,
    redirect: "error",
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
  });
  if (!response.ok)
    throw new AppError(
      "PROVIDER_ERROR",
      `Groq transcription returned HTTP ${response.status}. Check the key and speech model access.`,
      502,
    );
  const result = await response.json();
  assert(
    typeof result.text === "string" &&
      result.text.trim() &&
      result.text.length <= 4000,
    "PROVIDER_ERROR",
    "No usable speech was recognized. Try a shorter recording with clear speech.",
    502,
  );
  return { text: result.text.trim() as string };
}
