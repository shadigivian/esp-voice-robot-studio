#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = {
  ...process.env,
  APP_MODE: "demo",
  APP_BASE_URL: `http://127.0.0.1:${process.env.PORT || "3100"}`,
  NEXT_TELEMETRY_DISABLED: "1",
  DEMO_SESSION_SECRET: randomBytes(48).toString("base64url"),
  // Demo receives neither real provider keys nor a connection to production storage.
  OPENAI_API_KEY: "",
  DASHSCOPE_API_KEY: "",
  GROQ_API_KEY: "",
  SPEECH_BRIDGE_TOKEN: "",
  DATABASE_URL: "",
  MANAGEMENT_ADAPTER_SECRET: "",
  VOICE_SERVER_URL: "",
};
const child = spawn(
  process.execPath,
  [
    ...process.execArgv,
    resolve(cwd, "node_modules/next/dist/bin/next"),
    "dev",
    "--webpack",
    "--hostname",
    "127.0.0.1",
    "--port",
    process.env.PORT || "3100",
  ],
  { cwd, env, stdio: "inherit", windowsHide: true },
);
child.on("error", () => {
  process.stderr.write(
    "Demo could not start. Install dependencies with npm ci first.\n",
  );
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 0;
});
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
