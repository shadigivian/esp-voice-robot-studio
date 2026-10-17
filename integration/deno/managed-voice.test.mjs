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

test('actual managed WebSocket route rejects browser and missing tokens, drops interrupted generation, closes on source revocation', async () => {
  const directory = new URL('../../.local/adapter-test/', import.meta.url);
  await mkdir(directory, { recursive: true });
  const source = await readFile(new URL('./managed-voice.ts', import.meta.url), 'utf8');
  const built = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replaceAll("'npm:ws'", "'ws'").replace("'./core.mjs'", "'../../integration/deno/core.mjs'");
  const compiled = new URL('managed-voice.mjs', directory); await writeFile(compiled, built);
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
