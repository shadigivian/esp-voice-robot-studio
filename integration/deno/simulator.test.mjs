import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('simulator exercises HTTP bootstrap, bound claim, heartbeat and only supported command ACKs', async () => {
  const actions = [], acknowledgements = [];
  const bootstrapSecret = 'fixture-unique-bootstrap-secret-256-bits-not-real';
  const token = 'fixture-device-token-256-bits-not-real';
  let connectionId, nonce;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    actions.push(input.action);
    let data;
    if (input.action === 'bootstrap') {
      assert.equal(input.bootstrapSecret, bootstrapSecret);
      assert.ok(input.connectionId); assert.ok(input.nonce);
      connectionId = input.connectionId; nonce = input.nonce;
      data = { claimId: 'fixture-claim', code: '000123', expiresAt: new Date(Date.now() + 60000).toISOString() };
    } else if (input.action === 'claim_status') {
      assert.equal(input.claimId, 'fixture-claim'); assert.equal(input.connectionId, connectionId); assert.equal(input.nonce, nonce);
      data = { status: 'paired', deviceId: 'fixture-device', token, refreshToken: 'fixture-refresh-token-not-real', expiresAt: new Date(Date.now() + 900000).toISOString() };
    } else if (input.action === 'heartbeat') {
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      assert.equal(input.token, token); assert.ok(input.capabilities.includes('simulator'));
      data = { configVersion: 2, commands: [
        { id: 'config', type: 'config', payload: { configVersion: 2 } },
        { id: 'volume', type: 'volume', payload: { value: 40 } },
        { id: 'oled', type: 'display_sleep', payload: { enabled: true } },
      ] };
    } else if (input.action === 'ack') { acknowledgements.push(input); data = { status: input.status }; }
    else throw new Error('Unexpected fixture request');
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    const script = fileURLToPath(new URL('../../scripts/device-simulator.mjs', import.meta.url));
    const child = spawn(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', script, '--once'], {
      env: { ...process.env, MANAGEMENT_BASE_URL: `http://127.0.0.1:${address.port}`,
        DEVICE_BOOTSTRAP_SECRET: bootstrapSecret, SIMULATOR_STATE_FILE: '', VOICE_SERVER_URL: '' }, windowsHide: true,
    });
    let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
    const exitCode = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    assert.equal(exitCode, 0, output);
    assert.deepEqual(actions, ['bootstrap', 'claim_status', 'heartbeat', 'ack', 'ack', 'ack']);
    assert.deepEqual(acknowledgements.map((ack) => [ack.commandId, ack.status]), [['config', 'applied'], ['volume', 'applied'], ['oled', 'failed']]);
    assert.ok(!output.includes(bootstrapSecret)); assert.ok(!output.includes(token));
    assert.match(output, /SIMULATED DEVICE SCREEN/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
