import { Buffer } from 'node:buffer';

/** Shared Node/Deno speech transport. Configuration and keys are server-owned. */
export class SpeechError extends Error {
  constructor(code, message, status = 502) { super(message); this.code = code; this.status = status; }
}
const requireValue = (condition, code, message, status = 502) => {
  if (!condition) throw new SpeechError(code, message, status);
};
export function speechBridgeUrl(raw) {
  let url; try { url = new URL(raw); } catch { /* validated below */ }
  requireValue(url && !url.username && !url.password && !url.search && !url.hash &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))),
  'SETUP_REQUIRED', 'Configure GROQ_TTS_URL as a loopback HTTP or trusted HTTPS speech bridge URL.', 503);
  return url.toString();
}
export function speechConfig(env) {
  return {
    key: env('GROQ_API_KEY'), textModel: env('GROQ_TEXT_MODEL') || 'qwen/qwen3.8-27b',
    sttModel: env('GROQ_STT_MODEL') || 'whisper-large-v3-turbo', language: env('GROQ_LANGUAGE') || 'fa',
    ttsUrl: env('GROQ_TTS_URL'), speechBridgeToken: env('SPEECH_BRIDGE_TOKEN'),
    ttsVoice: env('GROQ_TTS_VOICE') || 'fa_IR-amir-medium',
  };
}
export function pcmWave(pcm, sampleRate = 16000) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, Buffer.from(pcm)]);
}
async function limitedBytes(response, limit) {
  requireValue(response.body, 'PROVIDER_ERROR', 'The speech provider returned no audio.');
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.length;
      if (bytes > limit) { await reader.cancel(); throw new SpeechError('AUDIO_LIMIT', 'The voice response exceeded its size limit.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
export async function synthesizeSpeech(config, text, signal, fetchImpl = fetch) {
  requireValue(config.speechBridgeToken && config.ttsUrl, 'SETUP_REQUIRED', 'Configure GROQ_TTS_URL and SPEECH_BRIDGE_TOKEN for Persian speech.', 503);
  requireValue(typeof text === 'string' && text.trim() && text.length <= 3000, 'AUDIO_LIMIT', 'The spoken response is too long.');
  const response = await fetchImpl(speechBridgeUrl(config.ttsUrl), {
    method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000),
    headers: { Authorization: `Bearer ${config.speechBridgeToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice: config.ttsVoice }),
  });
  requireValue(response.ok, 'SPEECH_BRIDGE_ERROR', `The Persian speech bridge returned HTTP ${response.status}.`);
  requireValue(response.headers.get('content-type')?.split(';')[0].trim() === 'audio/pcm' &&
    response.headers.get('x-audio-sample-rate') === '24000', 'PROVIDER_ERROR', 'The speech bridge must return mono PCM16 at 24 kHz.');
  const audio = await limitedBytes(response, 2_000_000);
  requireValue(audio.length > 0 && audio.length % 2 === 0, 'PROVIDER_ERROR', 'The speech bridge returned invalid PCM16 audio.');
  return audio;
}

/** Device-only bounded turn; tool execution remains bound to the published session. */
export async function groqSpeechTurn({ config, pcm, greeting, instructions, history = [], tools = [], execute,
  check = async () => {}, onUsage = async () => {}, signal, fetchImpl = fetch }) {
  requireValue(config.key, 'SETUP_REQUIRED', 'Configure GROQ_API_KEY.', 503);
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000);
  await check(); requestSignal.throwIfAborted();
  let transcript = '';
  if (pcm) {
    requireValue(pcm.length >= 3200 && pcm.length <= 480000 && pcm.length % 2 === 0, 'INVALID_AUDIO', 'Send 0.1 to 15 seconds of mono PCM16 at 16 kHz.', 400);
    const form = new FormData(); form.set('file', new Blob([pcmWave(pcm)]), 'speech.wav');
    form.set('model', config.sttModel); form.set('language', config.language); form.set('response_format', 'json'); form.set('temperature', '0');
    const response = await fetchImpl('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${config.key}` }, body: form, signal: requestSignal,
    });
    requireValue(response.ok, 'PROVIDER_ERROR', `Groq transcription returned HTTP ${response.status}.`);
    const result = await response.json();
    requireValue(typeof result.text === 'string' && result.text.trim() && result.text.length <= 4000, 'PROVIDER_ERROR', 'No usable speech was recognized.');
    transcript = result.text.trim();
    await onUsage({ provider: 'groq-stt', model: config.sttModel, usage: { audio_input_seconds: pcm.length / 32000 }, final: true, eventId: crypto.randomUUID() });
    await check();
  }
  let answer = greeting?.slice(0, 300) || '';
  const messages = [{ role: 'system', content: instructions }, ...history.slice(-12), { role: 'user', content: transcript }];
  const names = new Set(tools.map((tool) => tool.name)), handled = new Set(); let ended = false;
  if (!answer) for (let round = 0; round < 5; round++) {
    requestSignal.throwIfAborted(); await check();
    const response = await fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', redirect: 'error', signal: requestSignal,
      headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.textModel, messages, stream: false, max_completion_tokens: 700,
        ...(config.textModel.startsWith('qwen/') ? { reasoning_effort: 'none', reasoning_format: 'hidden' } : {}),
        ...(tools.length ? { tools: tools.map(({ type, ...tool }) => ({ type, function: tool })), tool_choice: 'auto' } : {}),
      }),
    });
    requireValue(response.ok, 'PROVIDER_ERROR', `Groq conversation returned HTTP ${response.status}.`);
    const result = await response.json(), message = result.choices?.[0]?.message;
    await check(); requestSignal.throwIfAborted();
    const usage = {};
    for (const [target, source] of [['input_tokens', 'prompt_tokens'], ['output_tokens', 'completion_tokens']])
      if (typeof result.usage?.[source] === 'number' && Number.isFinite(result.usage[source]) && result.usage[source] >= 0) usage[target] = result.usage[source];
    if (Object.keys(usage).length) await onUsage({ provider: 'groq-chat', model: config.textModel, usage, final: true, eventId: crypto.randomUUID() });
    requireValue(message?.role === 'assistant', 'PROVIDER_ERROR', 'Groq returned an invalid assistant response.');
    const calls = message.tool_calls;
    requireValue(calls == null || Array.isArray(calls), 'TOOL_DENIED', 'Groq returned invalid tool calls.');
    if (!calls?.length) {
      requireValue(typeof message.content === 'string' && message.content.trim() && message.content.length <= 3000, 'PROVIDER_ERROR', 'Groq returned missing or oversized speech text.');
      answer = message.content.trim(); break;
    }
    requireValue(calls.length <= 8 && handled.size + calls.length <= 20, 'TOOL_LIMIT', 'Groq exceeded the tool limit.');
    messages.push({ role: 'assistant', content: message.content || null, tool_calls: calls });
    for (const call of calls) {
      requireValue(typeof call?.id === 'string' && call.id.length > 0 && call.id.length <= 200 && !handled.has(call.id) && call.type === 'function' &&
        names.has(call.function?.name) && typeof call.function?.arguments === 'string' && call.function.arguments.length <= 4096,
      'TOOL_DENIED', 'Groq returned an unavailable tool call.');
      handled.add(call.id); await check(); requestSignal.throwIfAborted();
      let args; try { args = JSON.parse(call.function.arguments); } catch { throw new SpeechError('TOOL_DENIED', 'Groq returned invalid tool arguments.'); }
      const output = await execute(call.function.name, args); await check(); requestSignal.throwIfAborted();
      ended ||= call.function.name === 'end_session';
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) });
    }
  }
  requireValue(answer, 'TOOL_LIMIT', 'Groq did not finish within the tool round limit.');
  await check(); requestSignal.throwIfAborted();
  const audio = await synthesizeSpeech(config, answer, requestSignal, fetchImpl);
  await check(); requestSignal.throwIfAborted();
  await onUsage({ provider: 'speech-bridge', model: config.ttsVoice, usage: { audio_output_seconds: audio.length / 48000 }, final: true, eventId: crypto.randomUUID() });
  return { audio, answer, transcript, ended };
}

/** Bounded PCM energy detector. Input stays in memory for at most one 15 second turn. */
export class PcmTurnDetector {
  constructor({ threshold = 600, silenceMs = 900, maxMs = 15000, minMs = 250 } = {}) {
    this.threshold = threshold; this.silenceBytes = silenceMs * 32; this.maxBytes = maxMs * 32; this.minBytes = minMs * 32; this.reset();
  }
  reset() { this.chunks = []; this.bytes = 0; this.silent = 0; this.started = false; this.pending = null; }
  push(raw) {
    let pcm = Buffer.from(raw);
    if (this.pending !== null) { pcm = Buffer.concat([Buffer.from([this.pending]), pcm]); this.pending = null; }
    if (pcm.length % 2) { this.pending = pcm[pcm.length - 1]; pcm = pcm.subarray(0, -1); }
    // Device frames may be unusually large. Evaluate 20 ms windows for accurate silence boundaries.
    const completed = [];
    for (let offset = 0; offset < pcm.length; offset += 640) {
      const frame = pcm.subarray(offset, Math.min(offset + 640, pcm.length)); if (!frame.length) continue;
      let energy = 0; for (let i = 0; i < frame.length; i += 2) energy += frame.readInt16LE(i) ** 2;
      const active = Math.sqrt(energy / (frame.length / 2)) >= this.threshold;
      if (!this.started && !active) continue;
      this.started = true; this.chunks.push(Buffer.from(frame)); this.bytes += frame.length;
      this.silent = active ? 0 : this.silent + frame.length;
      if (this.bytes >= this.maxBytes || (this.bytes >= this.minBytes && this.silent >= this.silenceBytes)) {
        completed.push(Buffer.concat(this.chunks).subarray(0, this.maxBytes)); this.reset();
        // A single physical frame can contain subsequent ambient sound; never queue a second paid turn.
        break;
      }
    }
    return completed[0] || null;
  }
}
