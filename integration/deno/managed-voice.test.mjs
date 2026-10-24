import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { WebSocket } from 'ws';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const waitUntil = async (check) => {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Fixture timed out'); await new Promise((resolve) => setTimeout(resolve, 10)); }
};
class FixtureProvider extends EventEmitter {
  readyState = 1; sent = [];
  constructor() { super(); setTimeout(() => this.emit('open'), 0); }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.emit('close'); }
  message(data) { this.emit('message', Buffer.from(JSON.stringify(data))); }
}

let fixtureNumber = 0;
async function qwenFixture(t, settings = {}) {
  const directory = new URL('../../.local/adapter-test/', import.meta.url);
  await mkdir(directory, { recursive: true });
  const source = await readFile(new URL('./managed-voice.ts', import.meta.url), 'utf8');
  const built = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replaceAll("'npm:ws'", "'ws'").replace("'./core.mjs'", "'../../integration/deno/core.mjs'")
    .replace("'./managed-groq.mjs'", "'../../integration/deno/managed-groq.mjs'")
    .replace("'./groq-speech.mjs'", "'../../integration/deno/groq-speech.mjs'");
  const compiled = new URL(`qwen-voice-${process.pid}-${++fixtureNumber}.mjs`, directory); await writeFile(compiled, built);
  const previousDeno = globalThis.Deno;
  const env = { MANAGEMENT_ALLOW_LOCAL_HTTP: 'true', AI_PROVIDER: 'qwen', DASHSCOPE_API_KEY: 'fixture-qwen-key',
    DASHSCOPE_WORKSPACE_ID: 'workspace-fixture', DASHSCOPE_REGION: 'ap-southeast-1', ...settings.env };
  globalThis.Deno = { env: { get: (name) => env[name] } };
  let epoch = 1;
  const context = () => ({ deviceId: 'fixture-device', workspaceId: 'fixture-workspace', instructions: 'private fixture instructions',
    character: { voice: 'marin', ...settings.character }, knowledgeEpoch: epoch,
    privacy: { storeTranscripts: settings.transcripts === true } });
  const requests = [], providers = [], connections = [], controls = [], packets = [], pcm = [];
  const api = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString()); requests.push(input);
    assert.equal(input.token, 'fixture-device-token-32-characters');
    assert.equal(request.headers['x-management-adapter-key'], 'fixture-server-secret');
    let result;
    if (input.action === 'context') result = context();
    else if (input.action === 'start_session') result = { sessionId: 'fixture-session', context: context() };
    else if (input.action === 'search') result = settings.search ? await settings.search(input) : { status: 'ok', sources: [{ excerpt: 'device private fact' }] };
    else result = { accepted: true };
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: result }));
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  const { createManagedVoiceUpgrade } = await import(compiled.href);
  const hook = createManagedVoiceUpgrade({ baseUrl: `http://127.0.0.1:${api.address().port}`, adapterSecret: 'fixture-server-secret',
    ...settings.options,
    openProviderSocket: (url, headers) => { const provider = new FixtureProvider(); connections.push({ url, headers }); providers.push(provider); return provider; },
    createOpusPacketizer: (send) => ({ push: (audio) => { pcm.push(Buffer.from(audio)); send(audio); }, flush() {}, reset() {}, close() {} }),
  });
  const server = createServer(); server.on('upgrade', (request, socket, head) => { void hook(request, socket, head); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}/managed-voice`;
  const headers = { Authorization: 'Bearer fixture-device-token-32-characters', 'X-Elato-Playback-Ack': '1' };
  const device = new WebSocket(url, { headers });
  device.on('message', (raw, binary) => { if (binary) packets.push(Buffer.from(raw)); else controls.push(JSON.parse(raw.toString())); });
  const errors = []; device.on('error', (error) => errors.push(error));
  t.after(async () => {
    device.terminate();
    await new Promise((resolve) => server.close(resolve)); await new Promise((resolve) => api.close(resolve));
    globalThis.Deno = previousDeno; await rm(fileURLToPath(compiled), { force: true });
  });
  await waitUntil(() => device.readyState === WebSocket.OPEN || errors.length > 0);
  return { device, providers, connections, controls, packets, pcm, requests, errors,
    revoke: () => epoch++,
    instruction: (msg, fields = {}) => device.send(JSON.stringify({ type: 'instruction', msg, ...fields })),
    ready: async (selectedProvider) => {
      await waitUntil(() => !!(selectedProvider || providers[0]));
      const provider = selectedProvider || providers[0];
      provider.message({ type: 'session.created', session: { id: `qwen-session-${providers.indexOf(provider)}` } });
      await waitUntil(() => provider.sent.some((event) => event.type === 'session.update'));
      provider.message({ type: 'session.updated' });
      await waitUntil(() => controls.some((control) => control.type === 'auth'));
    },
  };
}

test('Qwen validates session readiness, bearer endpoint and exact PCM framing; playback ACK gates the microphone', async (t) => {
  const f = await qwenFixture(t);
  await waitUntil(() => f.providers.length === 1);
  const provider = f.providers[0];
  assert.equal(f.connections[0].url, 'wss://workspace-fixture.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-omni-flash-realtime');
  assert.equal(f.connections[0].headers.Authorization, 'Bearer fixture-qwen-key');
  assert.equal(provider.sent.length, 0);
  f.device.send(Buffer.from([1, 2, 3]));
  provider.message({ type: 'session.created', session: { id: 'qwen-fixture' } });
  await waitUntil(() => provider.sent.length > 0);
  const config = provider.sent[0];
  assert.equal(config.type, 'session.update');
  assert.equal(config.session.instructions, 'private fixture instructions');
  assert.equal(config.session.audio.input.format.sample_rate, 16000);
  assert.equal(config.session.audio.output.format.sample_rate, 24000);
  assert.equal(config.session.audio.output.voice, 'Tina');
  assert.equal(config.session.input_audio_transcription, null);
  assert.equal(config.session.turn_detection.type, 'semantic_vad');
  assert.equal(config.session.tools[0].function.name, 'search_device_knowledge');
  assert.equal(config.session.tool_choice, undefined);
  assert.equal(f.controls.length, 0);
  assert.equal(provider.sent.filter((event) => event.type === 'input_audio_buffer.append').length, 0);
  provider.message({ type: 'session.updated' });
  await waitUntil(() => f.controls.some((control) => control.type === 'auth'));
  f.device.send(Buffer.from([4, 5, 6]));
  await waitUntil(() => provider.sent.filter((event) => event.type === 'input_audio_buffer.append').length === 2);
  const input = () => provider.sent.filter((event) => event.type === 'input_audio_buffer.append');
  assert.deepEqual(Buffer.concat(input().map((event) => Buffer.from(event.audio, 'base64'))), Buffer.from([1, 2, 3, 4, 5, 6]));
  provider.message({ type: 'response.created', response: { id: 'response-a' } });
  f.device.send(Buffer.from([7, 8]));
  provider.message({ type: 'response.audio.delta', delta: Buffer.from([11]).toString('base64') });
  provider.message({ type: 'response.audio.delta', delta: Buffer.from([12, 13]).toString('base64') });
  provider.message({ type: 'response.audio.delta', delta: Buffer.from([14]).toString('base64') });
  await waitUntil(() => f.packets.length === 2);
  assert.deepEqual(Buffer.concat(f.pcm), Buffer.from([11, 12, 13, 14]));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(f.controls.filter((control) => control.msg === 'RESPONSE.COMPLETE').length, 1, 'idle audio gap must not finish Qwen response');
  provider.message({ type: 'response.done', response: { id: 'response-a', status: 'completed', usage: { input_tokens: 12, output_tokens: 7,
    input_tokens_details: { audio_tokens: 9, text_tokens: 3 }, output_tokens_details: { audio_tokens: 5, text_tokens: 2 } } } });
  await waitUntil(() => f.controls.some((control) => control.msg === 'RESPONSE.COMPLETE' && control.playback_id));
  const playback = f.controls.find((control) => control.msg === 'RESPONSE.COMPLETE' && control.playback_id).playback_id;
  f.device.send(Buffer.from([7, 8])); f.instruction('PLAYBACK.COMPLETE', { playback_id: playback + 1 }); f.device.send(Buffer.from([9, 10]));
  await new Promise((resolve) => setTimeout(resolve, 50)); assert.equal(input().length, 2);
  f.instruction('PLAYBACK.COMPLETE', { playback_id: playback }); f.device.send(Buffer.from([15, 16]));
  await waitUntil(() => input().length === 3);
  assert.deepEqual(Buffer.from(input()[2].audio, 'base64'), Buffer.from([15, 16]));
  provider.message({ type: 'response.audio_transcript.delta', delta: 'private response must not be retained' });
  assert.equal(f.requests.some((input) => input.action === 'server_event' && input.event.type === 'message'), false);
  f.instruction('END_SESSION');
  await waitUntil(() => f.requests.some((input) => input.action === 'end_session'));
  const usage = f.requests.find((input) => input.action === 'server_event' && input.event.type === 'usage').event;
  assert.equal(usage.provider, 'qwen-realtime'); assert.equal(usage.usage.input_audio_tokens, 9); assert.equal(usage.usage.output_text_tokens, 2);
  assert.equal(f.requests.find((input) => input.action === 'end_session').usageConfirmed, true);
  assert.equal(provider.sent.some((event) => event.type.startsWith('session.input_audio') || event.type === 'session.close'), false);
});

test('Qwen tools use the bound device context, deduplicate calls and usage, and only continue after response.done', async (t) => {
  const f = await qwenFixture(t, { transcripts: true, env: { QWEN_VOICE: 'Ethan' } });
  await f.ready(); const provider = f.providers[0];
  assert.equal(provider.sent[0].session.audio.output.voice, 'Ethan');
  assert.equal(provider.sent[0].session.input_audio_transcription.model, 'qwen3-asr-flash-realtime');
  provider.message({ type: 'response.created', response: { id: 'tool-response' } });
  const call = { type: 'response.function_call_arguments.done', call_id: 'call-one', name: 'search_device_knowledge', arguments: '{"query":"private fact"}' };
  provider.message(call); provider.message(call);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(f.requests.filter((input) => input.action === 'search').length, 0);
  const done = { type: 'response.done', response: { id: 'tool-response', status: 'completed', output: [
    { ...call, type: 'function_call' },
  ], usage: { input_tokens: 12, output_tokens: 7 } } };
  provider.message(done); provider.message(done);
  await waitUntil(() => provider.sent.some((event) => event.type === 'response.create'));
  assert.equal(f.requests.filter((input) => input.action === 'search').length, 1);
  const search = f.requests.find((input) => input.action === 'search');
  assert.equal(search.sessionId, 'fixture-session'); assert.equal(search.deviceId, undefined); assert.equal(search.query, 'private fact');
  const result = provider.sent.find((event) => event.type === 'conversation.item.create');
  assert.equal(result.item.call_id, 'call-one'); assert.match(result.item.output, /device private fact/);
  assert.equal(provider.sent.filter((event) => event.type === 'response.create').length, 1);
  assert.equal(f.requests.filter((input) => input.action === 'server_event' && input.event.type === 'usage').length, 1);
  provider.message({ type: 'response.created', response: { id: 'voice-response' } });
  provider.message({ type: 'response.audio_transcript.delta', delta: 'پاسخ فارسی' });
  provider.message({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'سلام' });
  provider.message({ type: 'response.done', response: { id: 'voice-response', status: 'completed', usage: { input_tokens: 15, output_tokens: 9 } } });
  await waitUntil(() => f.requests.filter((input) => input.action === 'server_event' && input.event.type === 'message').length === 2);
  f.revoke(); await waitUntil(() => f.device.readyState === WebSocket.CLOSED);
  assert.equal(f.controls.at(-1).reason, 'access_or_sources_changed');
});

test('Qwen interruptions discard old audio, tool work and ready events; provider errors never expose private diagnostics', async (t) => {
  let resolveSearch;
  const searchResult = new Promise((resolve) => { resolveSearch = resolve; });
  const f = await qwenFixture(t, { search: () => searchResult });
  await f.ready(); const old = f.providers[0];
  old.message({ type: 'response.created', response: { id: 'old-response' } });
  old.message({ type: 'response.function_call_arguments.done', call_id: 'old-call', name: 'search_device_knowledge', arguments: '{"query":"private"}' });
  old.message({ type: 'response.done', response: { id: 'old-response', status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } });
  await waitUntil(() => f.requests.some((input) => input.action === 'search'));
  f.instruction('INTERRUPT'); await waitUntil(() => f.providers.length === 2);
  resolveSearch({ status: 'ok', sources: [{ excerpt: 'stale private secret' }] });
  old.message({ type: 'session.updated' }); old.message({ type: 'response.audio.delta', delta: Buffer.from([1, 2]).toString('base64') });
  await f.ready(f.providers[1]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(f.packets.length, 0);
  assert.equal(old.sent.some((event) => event.type === 'conversation.item.create'), false);
  assert.equal(f.providers[1].sent.some((event) => JSON.stringify(event).includes('stale private secret')), false);
  f.providers[1].message({ type: 'error', error: { code: 'bad_request', message: 'private provider diagnostic', secret: 'fixture-qwen-key' } });
  await waitUntil(() => f.device.readyState === WebSocket.CLOSED);
  assert.equal(f.controls.at(-1).reason, 'provider_error');
  assert.equal(JSON.stringify(f.controls).includes('private provider diagnostic'), false);
  assert.equal(JSON.stringify(f.requests.filter((input) => input.action === 'server_event')).includes('private provider diagnostic'), false);
});

test('Qwen refuses missing workspace and insecure endpoints before accepting device audio', async (t) => {
  for (const env of [{ DASHSCOPE_WORKSPACE_ID: undefined }, { QWEN_REALTIME_URL: 'ws://provider.invalid/realtime' }]) {
    await t.test(JSON.stringify(env), async (t) => {
      const f = await qwenFixture(t, { env });
      assert.match(f.errors[0].message, /503/); assert.equal(f.providers.length, 0);
    });
  }
});

test('Qwen greets once after configuration and survives repeated touch interruptions without replaying it', async (t) => {
  const f = await qwenFixture(t, { character: { greeting: 'سلام، من دستیار شما هستم.', language: 'fa', voice: 'Tina' } });
  await f.ready(); const original = f.providers[0];
  const greeting = original.sent.find((event) => event.type === 'conversation.item.create');
  assert.equal(greeting.item.role, 'user'); assert.equal(greeting.item.content[0].type, 'input_text');
  assert.match(greeting.item.content[0].text, /سلام/);
  assert.equal(original.sent.filter((event) => event.type === 'response.create').length, 1);
  f.instruction('INTERRUPT'); f.instruction('INTERRUPT');
  await waitUntil(() => f.providers.length >= 2);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(f.providers.length, 2); assert.equal(f.device.readyState, WebSocket.OPEN);
  await f.ready(f.providers[1]);
  assert.equal(f.providers[1].sent.some((event) => event.type === 'conversation.item.create' || event.type === 'response.create'), false);
  f.instruction('END_SESSION');
  await waitUntil(() => f.device.readyState === WebSocket.CLOSED);
});

test('Groq managed route uses bounded PCM turns, retains playback ACK gating, private tools and source revocation', async (t) => {
  const requests = []; let speech = 0;
  const f = await qwenFixture(t, {
    env: { AI_PROVIDER: 'groq', GROQ_API_KEY: 'fixture-groq-key', GROQ_TTS_URL: 'http://127.0.0.1:8765/speech', SPEECH_BRIDGE_TOKEN: 'fixture-tts-token' },
    options: {
      detectorOptions: { threshold: 100, maxMs: 100, minMs: 100 },
      fetchProvider: async (url, init) => {
        requests.push({ url, init });
        if (url.endsWith('/transcriptions')) return Response.json({ text: 'سلام' });
        if (url.endsWith('/completions')) return Response.json({ choices: [{ message: { role: 'assistant', content: 'سلام دوست من' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } });
        speech++; return new Response(Buffer.from([1, 2, 3, 4]), { headers: { 'content-type': 'audio/pcm', 'x-audio-sample-rate': '24000' } });
      },
    },
  });
  await waitUntil(() => f.controls.some((value) => value.type === 'auth'));
  assert.equal(f.providers.length, 0, 'Groq must never open an unsupported realtime socket');
  const voice = Buffer.alloc(3200); for (let i = 0; i < voice.length; i += 2) voice.writeInt16LE(2000, i);
  f.device.send(voice);
  await waitUntil(() => f.controls.some((value) => value.msg === 'RESPONSE.COMPLETE' && value.playback_id));
  const playback = f.controls.find((value) => value.msg === 'RESPONSE.COMPLETE' && value.playback_id).playback_id;
  const committed = f.controls.findIndex((value) => value.msg === 'AUDIO.COMMITTED');
  assert.ok(committed >= 0 && committed < f.controls.findIndex((value) => value.msg === 'RESPONSE.CREATED'), 'accepted Groq input must put firmware in PROCESSING before speech starts');
  assert.equal(speech, 1); assert.deepEqual(Buffer.concat(f.pcm), Buffer.from([1, 2, 3, 4]));
  f.device.send(voice); f.instruction('PLAYBACK.COMPLETE', { playback_id: playback + 1 }); f.device.send(voice);
  await new Promise((resolve) => setTimeout(resolve, 50)); assert.equal(speech, 1);
  f.instruction('PLAYBACK.COMPLETE', { playback_id: playback }); f.device.send(voice);
  await waitUntil(() => speech === 2);
  await waitUntil(() => f.controls.some((value) => value.msg === 'RESPONSE.COMPLETE' && value.playback_id === playback + 1));
  assert.equal(f.requests.some((value) => value.event?.type === 'message'), false, 'transcripts remain opt-in');
  assert.equal(requests.filter(({ url }) => url.endsWith('/transcriptions')).length, 2);
  f.revoke(); await waitUntil(() => f.device.readyState === WebSocket.CLOSED);
  assert.ok(f.controls.some((value) => value.msg === 'AUDIO.CLEAR'));
  await waitUntil(() => f.requests.some((value) => value.action === 'end_session'));
  assert.equal(f.requests.find((value) => value.action === 'end_session').usageConfirmed, true, 'completed inference keeps usage confirmed when later authorization changes');
});

test('Groq touch interruption drops stale speech and retains uncertain usage after a subsequent successful turn', async (t) => {
  let releaseSpeech, requested = false, speechCalls = 0;
  const f = await qwenFixture(t, {
    env: { AI_PROVIDER: 'groq', GROQ_API_KEY: 'fixture-groq-key', GROQ_TTS_URL: 'http://127.0.0.1:8765/speech', SPEECH_BRIDGE_TOKEN: 'fixture-tts-token' },
    options: {
      detectorOptions: { threshold: 100, maxMs: 100 },
      fetchProvider: async (url) => {
        if (url.endsWith('/transcriptions')) return Response.json({ text: 'سلام' });
        if (url.endsWith('/completions')) return Response.json({ choices: [{ message: { role: 'assistant', content: 'پاسخ قبلی' } }] });
        requested = true;
        if (speechCalls++ === 0) await new Promise((resolve) => { releaseSpeech = resolve; });
        return new Response(Buffer.from([1, 2]), { headers: { 'content-type': 'audio/pcm', 'x-audio-sample-rate': '24000' } });
      },
    },
  });
  await waitUntil(() => f.controls.some((value) => value.type === 'auth'));
  const voice = Buffer.alloc(3200); for (let i = 0; i < voice.length; i += 2) voice.writeInt16LE(2000, i);
  f.device.send(voice); await waitUntil(() => requested);
  f.instruction('INTERRUPT'); await waitUntil(() => f.controls.some((value) => value.msg === 'AUDIO.CLEAR'));
  releaseSpeech(); await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(f.packets.length, 0); assert.equal(f.device.readyState, WebSocket.OPEN);
  f.device.send(voice);
  await waitUntil(() => f.controls.some((value) => value.msg === 'RESPONSE.COMPLETE' && value.playback_id));
  assert.equal(f.packets.length, 1, 'only the subsequent completed generation can send audio');
  f.instruction('END_SESSION');
  await waitUntil(() => f.requests.some((value) => value.action === 'end_session'));
  assert.equal(f.requests.find((value) => value.action === 'end_session').usageConfirmed, false, 'later successful inference cannot confirm usage from the interrupted request');
});

test('actual managed WebSocket route rejects browser and missing tokens, drops interrupted generation, closes on source revocation', async () => {
  const directory = new URL('../../.local/adapter-test/', import.meta.url);
  await mkdir(directory, { recursive: true });
  const source = await readFile(new URL('./managed-voice.ts', import.meta.url), 'utf8');
  const built = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replaceAll("'npm:ws'", "'ws'").replace("'./core.mjs'", "'../../integration/deno/core.mjs'")
    .replace("'./managed-groq.mjs'", "'../../integration/deno/managed-groq.mjs'")
    .replace("'./groq-speech.mjs'", "'../../integration/deno/groq-speech.mjs'");
  const compiled = new URL(`managed-voice-${process.pid}.mjs`, directory); await writeFile(compiled, built);
  const previousDeno = globalThis.Deno;
  globalThis.Deno = { env: { get: (name) => name === 'MANAGEMENT_ALLOW_LOCAL_HTTP' ? 'true' : undefined } };
  let epoch = 1;
  const context = () => ({ deviceId: 'fixture-device', workspaceId: 'fixture-workspace', instructions: 'fixture shared context',
    character: { voice: 'marin' }, tools: [], knowledgeEpoch: epoch, privacy: { storeTranscripts: false } });
  const api = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(input.token, 'fixture-device-token-32-characters');
    let result;
    if (input.action === 'context') result = context();
    else if (input.action === 'start_session') result = { sessionId: 'fixture-session', context: context() };
    else result = { accepted: true };
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: result }));
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  const providers = [];
  const { createManagedVoiceUpgrade } = await import(compiled.href);
  assert.doesNotThrow(() => createManagedVoiceUpgrade({ baseUrl: 'http://untrusted.invalid',
    createOpusPacketizer: () => ({ push() {}, flush() {}, reset() {}, close() {} }) }));
  const hook = createManagedVoiceUpgrade({ baseUrl: `http://127.0.0.1:${api.address().port}`, adapterSecret: 'fixture-server-secret', apiKey: 'fixture-not-a-live-key',
    openProviderSocket: () => { const provider = new FixtureProvider(); providers.push(provider); return provider; },
    createOpusPacketizer: (send) => ({ push: (pcm) => send(pcm), flush() {}, reset() {}, close() {} }),
  });
  const server = createServer();
  server.on('upgrade', (request, socket, head) => { void hook(request, socket, head); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}/managed-voice`;
  const headers = { Authorization: 'Bearer fixture-device-token-32-characters', 'X-Elato-Playback-Ack': '1' };
  let device;
  try {
    for (const testHeaders of [{}, { ...headers, Origin: 'https://browser.invalid' }]) {
      const denied = new WebSocket(url, { headers: testHeaders });
      const error = await new Promise((resolve) => denied.once('error', resolve));
      assert.match(error.message, /401|403/);
    }
    device = new WebSocket(url, { headers });
    let packets = 0; const controls = [];
    device.on('message', (raw, binary) => { if (binary) packets++; else controls.push(JSON.parse(raw.toString())); });
    await new Promise((resolve, reject) => { device.once('open', resolve); device.once('error', reject); });
    await waitUntil(() => providers[0]?.sent.some((event) => event.type === 'session.start'));
    const old = providers[0]; old.message({ type: 'session.started', session: { id: 'fixture-provider-1' } });
    old.message({ type: 'session.output_audio.delta', delta: Buffer.from([1, 2]).toString('base64') });
    await waitUntil(() => packets === 1);
    device.send(JSON.stringify({ type: 'instruction', msg: 'INTERRUPT' }));
    await waitUntil(() => providers.length === 2);
    old.message({ type: 'session.output_audio.delta', delta: Buffer.from([3, 4]).toString('base64') });
    await new Promise((resolve) => setTimeout(resolve, 50)); assert.equal(packets, 1);
    providers[1].message({ type: 'session.started', session: { id: 'fixture-provider-2' } });
    providers[1].message({ type: 'session.output_audio.delta', delta: Buffer.from([5, 6]).toString('base64') });
    await waitUntil(() => packets === 2);
    epoch++;
    await waitUntil(() => device.readyState === WebSocket.CLOSED);
    assert.ok(controls.some((control) => control.msg === 'AUDIO.CLEAR'));
    assert.equal(packets, 2);
    assert.equal(providers[1].sent.filter((event) => event.type === 'session.start').length, 1);
  } finally {
    device?.terminate();
    await new Promise((resolve) => server.close(resolve)); await new Promise((resolve) => api.close(resolve));
    globalThis.Deno = previousDeno;
    await rm(fileURLToPath(compiled), { force: true });
  }
});
