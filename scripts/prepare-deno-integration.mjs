#!/usr/bin/env node
/** Produce a reviewable patched copy INSIDE this repo; never modify the parent server automatically. */
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const panel = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!process.argv[2]) {
  throw new Error("Pass the path to your existing Elato Deno main.ts: node scripts/prepare-deno-integration.mjs /path/to/ElatoAI/server/deno/main.ts");
}
const source = resolve(process.argv[2]);
const output = resolve(panel, "integration/prepared");
let content = await readFile(source, "utf8");
if (content.includes("createManagedVoiceUpgrade"))
  throw new Error(
    "Source already contains a managed hook; inspect it before applying again.",
  );
const marker = "server.on('upgrade', async (req, socket, head) => {";
if (content.split(marker).length !== 2)
  throw new Error("Expected one existing upgrade handler. No files modified.");
content =
  "import { createManagedVoiceUpgrade } from './management/managed-voice.ts';\nimport { createOpusPacketizer } from './utils.ts';\n" +
  content;
content = content.replace(
  marker,
  "const tryManagedUpgrade = createManagedVoiceUpgrade({ createOpusPacketizer });\n\n" +
    marker +
    "\n    if (await tryManagedUpgrade(req, socket, head)) return;",
);
// Existing debug statement prints the Authorization header. Remove it in the prepared copy.
content = content.replace(
  /^[ \t]*console\.log\('foobar upgrade', req\.headers\);\r?\n/m,
  "",
);
await mkdir(resolve(output, "management"), { recursive: true });
await writeFile(resolve(output, "main.ts"), content);
for (const name of ["core.mjs", "managed-voice.ts"])
  await copyFile(
    resolve(panel, "integration/deno", name),
    resolve(output, "management", name),
  );
await copyFile(resolve(panel, "LICENSE"), resolve(output, "LICENSE"));
process.stdout.write(
  "Prepared integration/prepared/main.ts and management/. Review the diff, then install on the existing Deno server. Parent files were not modified.\n",
);
