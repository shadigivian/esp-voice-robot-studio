#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { companionPlan, studioRoot } from './companion-files.mjs';

const args = process.argv.slice(2);
const target = args.find((value) => !value.startsWith('--'));
if (!target || args.some((value) => value.startsWith('--') && !['--write', '--firmware'].includes(value))) {
  console.error('Usage: node scripts/install-companion.mjs PATH_TO_ELATOAI [--firmware] [--write]');
  process.exitCode = 1;
} else {
  try {
    const plan = await companionPlan(target, args.includes('--firmware'));
    const changes = [];
    for (const entry of plan.entries) {
      let original;
      try { original = await readFile(entry.destination); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!original?.equals(entry.data)) changes.push({ ...entry, original });
    }
    console.log(`Selected companion checkout: ${plan.target}`);
    for (const change of changes) console.log(`${change.original ? 'Update' : 'Create'} ${change.path}`);
    if (!args.includes('--write')) console.log('Preview only. Add --write to install these files. Private .env files are never changed.');
    else if (!changes.length) console.log('Companion files are already up to date.');
    else {
      const backup = resolve(studioRoot, '.local/companion-backups', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
      await mkdir(backup, { recursive: true });
      for (const change of changes) if (change.original) {
        const file = resolve(backup, change.path); await mkdir(dirname(file), { recursive: true });
        await writeFile(file, change.original);
      }
      await writeFile(resolve(backup, 'manifest.json'), JSON.stringify({ target: plan.target,
        files: changes.map(({ path, original }) => ({ path, existed: !!original })) }, null, 2));
      for (const change of changes) {
        await mkdir(dirname(change.destination), { recursive: true });
        await writeFile(change.destination, change.data);
      }
      console.log(`Installed ${changes.length} companion files. Original files backed up at ${backup}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Companion installation failed.');
    process.exitCode = 1;
  }
}
