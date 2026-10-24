import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { patchVoiceMain, patchCompanionSource, companionPlan } from '../../scripts/companion-files.mjs';

const compat = JSON.parse(await readFile(new URL('./companion-compat.json', import.meta.url), 'utf8'));
async function legacyFiles(directory) {
  await mkdir(join(directory, 'server/deno/models'), { recursive: true });
  for (const path of new Set(compat.map((rule) => rule.path)))
    await writeFile(join(directory, 'server/deno', path), path === 'deno.json' ? '{"compilerOptions":{}}' :
      compat.filter((rule) => rule.path === path).map((rule) => rule.before).join('\n'));
}

const source = `import { authenticateUser } from './utils.ts';
const server = createServer();
server.on('upgrade', async (req, socket, head) => {
    console.log('foobar upgrade', req.headers);
    await authenticateLegacy(req, socket, head);
});
server.listen(8080);
`;

test('companion patch preserves legacy auth/listener, removes bearer logging, and updates idempotently', () => {
  const patched = patchVoiceMain(source);
  assert.match(patched, /if \(await tryManagedUpgrade\(req, socket, head\)\) return;/);
  assert.ok(patched.indexOf('if (await tryManagedUpgrade') < patched.indexOf('await authenticateLegacy'));
  assert.match(patched, /server\.listen\(8080\)/);
  assert.doesNotMatch(patched, /foobar upgrade/);
  assert.equal(patchVoiceMain(patched), patched);
  assert.throws(() => patchVoiceMain('unknown source'), /compatible ElatoAI/);
  assert.throws(() => patchVoiceMain(source + '// createManagedVoiceUpgrade'), /Unrecognized existing/);
});

test('companion plan validates the existing server before preparing bounded source-only writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qwen-companion-'));
  try {
    await assert.rejects(companionPlan(directory));
    await mkdir(join(directory, 'server/deno'), { recursive: true });
    await writeFile(join(directory, 'server/deno/main.ts'), source);
    await legacyFiles(directory);
    const { entries } = await companionPlan(directory);
    assert.deepEqual(entries.map((entry) => entry.path), [
      'server/deno/main.ts', 'server/deno/types.d.ts', 'server/deno/deno.json',
      'server/deno/models/gemini.ts', 'server/deno/models/elevenlabs.ts', 'server/deno/management/managed-voice.ts',
      'server/deno/management/core.mjs', 'server/deno/management/.env.example',
      'server/deno/management/LICENSE',
    ]);
    assert.ok(entries.every((entry) => Buffer.isBuffer(entry.data)));
    assert.ok(entries.every((entry) => !entry.path.endsWith('/.env')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('companion plan rejects a linked destination even when it stays inside the checkout', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'qwen-companion-link-'));
  try {
    await mkdir(join(directory, 'server/deno'), { recursive: true });
    await mkdir(join(directory, 'private'), { recursive: true });
    await writeFile(join(directory, 'server/deno/main.ts'), source);
    await legacyFiles(directory);
    try { await symlink(join(directory, 'private'), join(directory, 'server/deno/management'), 'junction'); }
    catch (error) { if (error.code === 'EPERM') { t.skip('Runner does not permit link creation.'); return; } throw error; }
    await assert.rejects(companionPlan(directory), /symbolic links or junctions/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('companion compatibility patches are narrow and idempotent', () => {
  for (const path of new Set(compat.map((rule) => rule.path))) {
    const original = path === 'deno.json' ? '{"compilerOptions":{}}' :
      compat.filter((rule) => rule.path === path).map((rule) => rule.before).join('\n');
    const patched = patchCompanionSource(path, original, compat);
    assert.equal(patchCompanionSource(path, patched, compat), patched);
    const windows = patchCompanionSource(path, original.replaceAll('\n', '\r\n'), compat);
    assert.equal(patchCompanionSource(path, windows, compat), windows);
    if (path !== 'deno.json') assert.throws(() => patchCompanionSource(path, 'different server revision', compat), /Unrecognized companion source/);
  }
});

test('Deno compatibility preserves configured ambient types without duplicate JSON keys', () => {
  const original = '{"compilerOptions":{"types":["./custom.d.ts"]},"imports":{"alias":"npm:example"}}';
  const result = JSON.parse(patchCompanionSource('deno.json', original, compat));
  assert.deepEqual(result.compilerOptions.types, ['./custom.d.ts', './types.d.ts']);
  assert.deepEqual(result.imports, { alias: 'npm:example' });
});
