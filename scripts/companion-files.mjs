import { readFile, realpath, lstat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const studioRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function patchCompanionSource(path, content, rules) {
  if (path === 'deno.json') {
    const config = JSON.parse(content);
    config.compilerOptions ??= {};
    const types = config.compilerOptions.types ?? [];
    if (!Array.isArray(types) || types.some((type) => typeof type !== 'string'))
      throw new Error('Unrecognized Deno ambient types configuration. No files modified.');
    config.compilerOptions.types = [...new Set([...types, './types.d.ts'])];
    return JSON.stringify(config, null, 2) + '\n';
  }
  const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
  content = content.replaceAll('\r\n', '\n');
  for (const rule of rules.filter((entry) => entry.path === path)) {
    if (content.includes(rule.after)) continue;
    if (content.split(rule.before).length !== 2)
      throw new Error(`Unrecognized companion source in ${path}. No files modified.`);
    content = content.replace(rule.before, rule.after);
  }
  return lineEnding === '\r\n' ? content.replaceAll('\n', '\r\n') : content;
}

export function patchVoiceMain(content) {
  const marker = "server.on('upgrade', async (req, socket, head) => {";
  if (content.split(marker).length !== 2)
    throw new Error('Expected exactly one compatible ElatoAI upgrade handler. No files modified.');
  if (content.includes('createManagedVoiceUpgrade')) {
    for (const expected of [
      "import { createManagedVoiceUpgrade } from './management/managed-voice.ts';",
      'const tryManagedUpgrade = createManagedVoiceUpgrade({ createOpusPacketizer });',
      'if (await tryManagedUpgrade(req, socket, head)) return;',
    ]) {
      if (content.split(expected).length !== 2)
        throw new Error('Unrecognized existing management integration. No files modified.');
    }
  } else {
    content = "import { createManagedVoiceUpgrade } from './management/managed-voice.ts';\n" +
      "import { createOpusPacketizer } from './utils.ts';\n" + content;
    content = content.replace(marker,
      'const tryManagedUpgrade = createManagedVoiceUpgrade({ createOpusPacketizer });\n\n' + marker +
      '\n    if (await tryManagedUpgrade(req, socket, head)) return;');
  }
  return content.replace(/^[ \t]*console\.log\('foobar upgrade', req\.headers\);\r?\n/m, '');
}

export async function companionPlan(targetRoot, includeFirmware = false) {
  const target = await realpath(resolve(targetRoot));
  const entries = [];
  const add = async (path, source, content) => {
    const destination = resolve(target, path);
    const child = relative(target, destination);
    if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('Invalid companion destination.');
    let current = target;
    for (const segment of child.split(sep)) {
      current = resolve(current, segment);
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new Error('Companion destinations must not contain symbolic links or junctions.');
      } catch (error) { if (error.code === 'ENOENT') break; throw error; }
    }
    // Reject existing parent links that would send a write outside the selected checkout.
    let parent = dirname(destination);
    for (;;) {
      try {
        const actual = await realpath(parent);
        const part = relative(target, actual);
        if (part.startsWith('..') || isAbsolute(part)) throw new Error('Companion destination leaves the checkout.');
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        parent = dirname(parent);
      }
    }
    try {
      const actual = await realpath(destination);
      const part = relative(target, actual);
      if (part.startsWith('..') || isAbsolute(part)) throw new Error('Companion destination leaves the checkout.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    entries.push({ path, destination, data: content ?? await readFile(source) });
  };
  const main = resolve(target, 'server/deno/main.ts');
  await add('server/deno/main.ts', null, Buffer.from(patchVoiceMain(await readFile(main, 'utf8'))));
  const compat = JSON.parse(await readFile(resolve(studioRoot, 'integration/deno/companion-compat.json'), 'utf8'));
  for (const path of new Set(compat.map((rule) => rule.path))) {
    if (!['types.d.ts', 'deno.json', 'models/gemini.ts', 'models/elevenlabs.ts'].includes(path))
      throw new Error('Invalid companion compatibility path.');
    const original = await readFile(resolve(target, 'server/deno', path), 'utf8');
    await add(`server/deno/${path}`, null, Buffer.from(patchCompanionSource(path, original, compat)));
  }
  for (const name of ['managed-voice.ts', 'core.mjs', '.env.example'])
    await add(`server/deno/management/${name}`, resolve(studioRoot, 'integration/deno', name));
  await add('server/deno/management/LICENSE', resolve(studioRoot, 'LICENSE'));
  if (includeFirmware) {
    const sourceRoot = resolve(studioRoot, 'companion/firmware-arduino');
    const files = JSON.parse(await readFile(resolve(sourceRoot, 'manifest.json'), 'utf8')).files;
    if (!Array.isArray(files) || !files.length) throw new Error('Firmware source package is unavailable.');
    for (const path of files) {
      if (typeof path !== 'string' || path.split(/[\\/]/).includes('..') || isAbsolute(path) || /(^|\/)\.env/.test(path))
        throw new Error('Invalid firmware manifest.');
      await add(`firmware-arduino/${path}`, resolve(sourceRoot, path));
    }
  }
  return { target, entries };
}
