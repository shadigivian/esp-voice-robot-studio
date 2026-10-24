import { AppError, assert } from "./errors";
import { groqConfig } from "./groq-provider";
export { groqConfig, groqText, groqTranscribe } from "./groq-provider";

export type AIProvider = "openai" | "qwen" | "groq";
export function aiProvider(): AIProvider {
  const value =
    process.env.AI_PROVIDER || process.env.VOICE_PROVIDER || "openai";
  assert(
    value === "openai" || value === "qwen" || value === "groq",
    "SETUP_REQUIRED",
    "AI_PROVIDER must be openai, qwen or groq.",
    503,
  );
  return value;
}
function endpoint(raw: string, protocol: "https:" | "wss:") {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError("SETUP_REQUIRED", "The Qwen endpoint is invalid.", 503);
  }
  assert(
    url.protocol === protocol &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.search,
    "SETUP_REQUIRED",
    "Qwen endpoints must be secure URLs without credentials, query strings or fragments.",
    503,
  );
  return raw.replace(/\/$/, "");
}
export function qwenConfig() {
  const region = process.env.DASHSCOPE_REGION || "ap-southeast-1";
  const workspace = process.env.DASHSCOPE_WORKSPACE_ID;
  assert(
    ["ap-southeast-1", "cn-beijing"].includes(region),
    "SETUP_REQUIRED",
    "Set DASHSCOPE_REGION to ap-southeast-1 or cn-beijing.",
    503,
  );
  assert(
    !workspace || /^[a-zA-Z0-9_-]+$/.test(workspace),
    "SETUP_REQUIRED",
    "The DashScope workspace identifier is invalid.",
    503,
  );
  const origin = workspace
    ? `${workspace}.${region}.maas.aliyuncs.com`
    : region === "cn-beijing"
      ? "dashscope.aliyuncs.com"
      : "dashscope-intl.aliyuncs.com";
  return {
    key: process.env.DASHSCOPE_API_KEY,
    textEndpointConfigured: !!(workspace || process.env.QWEN_BASE_URL),
    realtimeEndpointConfigured: !!(workspace || process.env.QWEN_REALTIME_URL),
    baseUrl: endpoint(
      process.env.QWEN_BASE_URL || `https://${origin}/compatible-mode/v1`,
      "https:",
    ),
    realtimeUrl: endpoint(
      process.env.QWEN_REALTIME_URL || `wss://${origin}/api-ws/v1/realtime`,
      "wss:",
    ),
    textModel: process.env.QWEN_TEXT_MODEL || "qwen3.8-omni-flash",
    realtimeModel:
      process.env.QWEN_REALTIME_MODEL || "qwen3.8-omni-flash-realtime",
    voice: process.env.QWEN_VOICE || "Tina",
  };
}
export function qwenVoice(savedVoice?: string) {
  const openaiVoices = new Set([
    "alloy",
    "ash",
    "ballad",
    "coral",
    "echo",
    "sage",
    "shimmer",
    "verse",
    "marin",
    "cedar",
    "fable",
    "onyx",
    "nova",
  ]);
  return (
    (savedVoice && !openaiVoices.has(savedVoice.toLowerCase())
      ? savedVoice
      : undefined) ||
    process.env.QWEN_VOICE ||
    process.env.QWEN_REALTIME_VOICE ||
    "Tina"
  );
}
export function providerReadiness() {
  const provider = aiProvider();
  if (provider === "groq") {
    const groq = groqConfig();
    return {
      provider,
      configured: !!groq.key,
      textModel: groq.textModel,
      realtimeModel: null,
      browserVoice: false,
      voiceSamples: !!(groq.key && groq.ttsUrl && groq.speechBridgeToken),
    };
  }
  const qwen = provider === "qwen" ? qwenConfig() : null;
  const key =
    qwen?.key ||
    (provider === "openai" ? process.env.OPENAI_API_KEY : undefined);
  return {
    provider,
    configured:
      !!key &&
      (!qwen ||
        (qwen.textEndpointConfigured && qwen.realtimeEndpointConfigured)),
    textModel: qwen?.textModel || process.env.OPENAI_TEXT_MODEL || null,
    realtimeModel:
      qwen?.realtimeModel || process.env.OPENAI_REALTIME_MODEL || null,
    browserVoice: provider === "openai",
    voiceSamples: provider === "qwen" || !!process.env.OPENAI_TTS_MODEL,
  };
}

interface FunctionTool {
  type: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
/** Server-owned tool loop. Only the caller's authenticated, revision-bound tools execute. */
export async function qwenText(input: {
  instructions: string;
  content: string;
  tools: FunctionTool[];
  execute: (name: string, args: unknown) => Promise<unknown>;
}) {
  const config = qwenConfig();
  assert(
    config.key && config.textEndpointConfigured,
    "SETUP_REQUIRED",
    "Configure DASHSCOPE_API_KEY and DASHSCOPE_WORKSPACE_ID (or QWEN_BASE_URL) to run a Qwen text test.",
    503,
  );
  const messages: Record<string, unknown>[] = [
    { role: "system", content: input.instructions },
    { role: "user", content: input.content },
  ];
  const usage: Record<string, number> = {};
  const signal = AbortSignal.timeout(45_000);
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
        tools: input.tools.map(({ type, ...tool }) => ({
          type,
          function: tool,
        })),
        tool_choice: "auto",
        reasoning_effort: "none",
        modalities: ["text"],
        max_tokens: 700,
        stream: false,
      }),
      signal,
      redirect: "error",
    });
    if (!response.ok)
      throw new AppError(
        "PROVIDER_ERROR",
        `Qwen text provider returned HTTP ${response.status}. Check the region, key and model access.`,
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
      "Qwen returned an invalid assistant response.",
      502,
    );
    const calls = message.tool_calls;
    if (!Array.isArray(calls) || calls.length === 0) {
      assert(
        typeof message.content === "string" && message.content.trim(),
        "PROVIDER_ERROR",
        "Qwen returned no text. Check model compatibility.",
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
      "Qwen exceeded the tool call limit.",
      502,
    );
    messages.push({
      role: "assistant",
      content: message.content || null,
      tool_calls: calls,
    });
    for (const call of calls) {
      assert(
        typeof call.id === "string" &&
          call.id.length <= 200 &&
          !handled.has(call.id) &&
          call.type === "function" &&
          names.has(call.function?.name) &&
          typeof call.function?.arguments === "string" &&
          call.function.arguments.length <= 4096,
        "TOOL_DENIED",
        "Qwen returned an invalid or unavailable tool call.",
        502,
      );
      handled.add(call.id);
      let args: unknown;
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        throw new AppError(
          "PROVIDER_ERROR",
          "Qwen returned invalid tool arguments.",
          502,
        );
      }
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
    "Qwen did not finish within the tool round limit.",
    502,
  );
}
