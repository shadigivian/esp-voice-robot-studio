#!/usr/bin/env node
/** Produce a reviewable patched copy INSIDE this repo; never modify the parent server automatically. */
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { patchVoiceMain, patchCompanionSource } from "./companion-files.mjs";
const panel = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(panel, "../../server/deno/main.ts");
const output = resolve(panel, "integration/prepared");
const content = patchVoiceMain(await readFile(source, "utf8"));
const compat = JSON.parse(await readFile(resolve(panel, "integration/deno/companion-compat.json"), "utf8"));
const compatibilityFiles = [];
for (const name of new Set(compat.map((rule) => rule.path))) {
  if (!["types.d.ts", "deno.json", "models/gemini.ts", "models/elevenlabs.ts"].includes(name))
    throw new Error("Invalid companion compatibility path. No files modified.");
  compatibilityFiles.push([name, patchCompanionSource(name, await readFile(resolve(dirname(source), name), "utf8"), compat)]);
}
await mkdir(resolve(output, "management"), { recursive: true });
await writeFile(resolve(output, "main.ts"), content);
for (const [name, body] of compatibilityFiles) {
  await mkdir(dirname(resolve(output, name)), { recursive: true });
  await writeFile(resolve(output, name), body);
}
for (const name of ["core.mjs", "managed-voice.ts", ".env.example"])
  await copyFile(
    resolve(panel, "integration/deno", name),
    resolve(output, "management", name),
  );
await copyFile(resolve(panel, "LICENSE"), resolve(output, "LICENSE"));
process.stdout.write(
  "Prepared integration/prepared/main.ts and management/. Review the diff, then install on the existing Deno server. Parent files were not modified.\n",
);
