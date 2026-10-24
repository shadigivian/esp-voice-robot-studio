import test from 'node:test';
import assert from 'node:assert/strict';
import { ManagementClient, parseToolArgs, bindDevice, GenerationGate, Pcm16Resampler, Pcm16Frames } from './core.mjs';

test('management credentials never follow redirects or non-TLS remote endpoints', async () => {
  assert.throws(() => new ManagementClient({ baseUrl: 'http://example.com', allowLocalHttp: true }));
  assert.throws(() => new ManagementClient({ baseUrl: 'https://key:secret@example.com' }));
  let request;
  const client = new ManagementClient({ baseUrl: 'https://panel.example', fetchImpl: async (url, init) => {
    request = { url, init }; return new Response(JSON.stringify({ status: 'ok' }));
  } });
  await client.call('context', { token: 'device-token' });
  assert.equal(request.init.redirect, 'error');
  assert.equal(request.url.pathname, '/api/device');
});

test('model cannot supply another device, workspace, file or vector store identifier', async () => {
  for (const field of ['deviceId', 'workspaceId', 'file_id', 'vector_store_id']) {
    assert.throws(() => parseToolArgs('search_device_knowledge', { query: 'private', [field]: 'other' }));
  }
  assert.throws(() => parseToolArgs('delete_document', {}));
  assert.throws(() => parseToolArgs('get_verified_facts', { query: 'a'.repeat(1001) }));
});

test('runtime is bound to authenticated device and rejects source revocation during search', async () => {
  let epoch = 1, searched = false;
  const context = { workspaceId: 'w', deviceId: 'a', knowledgeEpoch: epoch, instructions: 'bound prompt' };
  const client = { async call(action, input) {
    assert.equal(input.token, 'device-a'); assert.equal(input.deviceId, undefined);
    if (action === 'context') return { ...context, knowledgeEpoch: epoch };
    if (action === 'search') { searched = true; epoch++; return { status: 'ok', sources: [{ excerpt: 'old private content' }] }; }
  } };
  const bound = bindDevice(client, 'device-a', context);
  await assert.rejects(bound.execute('search_device_knowledge', { query: 'secret' }), /context_revoked/);
  assert.equal(searched, true);
});

test('every tool revalidates token revocation, including public profile', async () => {
  const client = { call: async () => { throw new Error('revoked'); } };
  const bound = bindDevice(client, 'a', { deviceId: 'a', workspaceId: 'w', knowledgeEpoch: 1, instructions: 'prompt' });
  await assert.rejects(bound.execute('get_device_public_profile', {}), /revoked/);
});

test('manual interruption invalidates old provider callbacks and queued generation', () => {
  const gate = new GenerationGate(), first = gate.next(); assert.equal(gate.accepts(first), true);
  gate.close(); const next = gate.next(); assert.equal(gate.accepts(first), false); assert.equal(gate.accepts(next), true);
});

test('revoked HTTP credential is rejected without returning private response data', async () => {
  const client = new ManagementClient({ baseUrl: 'https://panel.example', fetchImpl: async () =>
    new Response(JSON.stringify({ error: { message: 'private diagnostic must not escape' } }), { status: 401 }) });
  await assert.rejects(client.call('context', { token: 'revoked' }), (error) =>
    error.code === 'device_unauthorized' && !error.message.includes('private'));
});

test('streaming 16k to 24k PCM conversion is independent of websocket chunk boundaries', () => {
  const input = Buffer.alloc(3200);
  for (let i = 0; i < 1600; i++) input.writeInt16LE(Math.round(Math.sin(i / 8) * 12000), i * 2);
  const whole = new Pcm16Resampler().push(input);
  const streamed = new Pcm16Resampler(); const chunks = [];
  for (let i = 0; i < input.length; i += 53) chunks.push(streamed.push(input.subarray(i, i + 53)));
  assert.deepEqual(Buffer.concat(chunks), Buffer.from(whole));
  assert.ok(whole.length >= 4794 && whole.length <= 4800);
});

test('PCM framing preserves exact audio samples across odd and empty chunks without resampling', () => {
  const frames = new Pcm16Frames();
  const chunks = [frames.push(Uint8Array.of(1)), frames.push(new Uint8Array()),
    frames.push(Uint8Array.of(2, 3, 4, 5)), frames.push(Uint8Array.of(6))];
  assert.deepEqual(Buffer.concat(chunks), Buffer.from([1, 2, 3, 4, 5, 6]));
});
