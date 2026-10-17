#!/usr/bin/env node
// Explicit device simulator. It never impersonates hardware or a successful provider call.
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { ManagementClient } from "../integration/deno/core.mjs";

const args = new Set(process.argv.slice(2));
const baseUrl = process.env.MANAGEMENT_BASE_URL || "http://localhost:3000";
const mac = process.env.SIMULATOR_MAC || "02:00:00:00:00:01";
const secret = process.env.DEVICE_BOOTSTRAP_SECRET;
const statePath = process.env.SIMULATOR_STATE_FILE;
const voiceUrl = process.env.VOICE_SERVER_URL;
const client = new ManagementClient({ baseUrl, allowLocalHttp: true });
const connectionId = randomUUID(),
  nonce = randomBytes(32).toString("hex");
let credentials,
  stopped = false,
  socket;
let conversation = "idle",
  configVersion = null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function save() {
  if (statePath)
    await writeFile(statePath, JSON.stringify(credentials), { mode: 0o600 });
}
async function refresh() {
  credentials = {
    ...credentials,
    ...(await client.call("refresh", {
      refreshToken: credentials.refreshToken,
    })),
  };
  await save();
}
async function pair() {
  if (!secret || secret.length < 32)
    throw new Error(
      "Set the unique, operator-provisioned DEVICE_BOOTSTRAP_SECRET (32+ characters). MAC alone is insufficient.",
    );
  const input = {
    mac,
    bootstrapSecret: secret,
    connectionId,
    nonce,
    ...(process.env.DEVICE_CLAIM_ID
      ? { claimId: process.env.DEVICE_CLAIM_ID }
      : {}),
  };
  const challenge = await client.call("bootstrap", input);
  input.claimId = challenge.claimId || input.claimId;
  // This is the simulated screen, not a service log. Do not persist this one-time code.
  process.stdout.write(
    `\nSIMULATED DEVICE SCREEN — pairing code: ${challenge.code}\nExpires: ${challenge.expiresAt}\nEnter the code in the device Claim form.\n`,
  );
  const expiresAt = Date.parse(challenge.expiresAt);
  while (!stopped && Date.now() < expiresAt) {
    await sleep(2500);
    const status = await client.call("claim_status", input);
    if (status.status === "paired") {
      credentials = status;
      await save();
      return;
    }
  }
  throw new Error("Pairing expired or simulator stopped.");
}
async function connectVoice() {
  if (!voiceUrl)
    throw new Error(
      "Set VOICE_SERVER_URL ending /managed-voice to explicitly test the existing voice server.",
    );
  const url = new URL(voiceUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && local))
    throw new Error("Voice requires WSS except on loopback.");
  const { default: WebSocket } = await import("ws");
  conversation = "connecting";
  socket = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${credentials.token}`,
      "X-Device-Mac": mac,
      "X-Elato-Playback-Ack": "1",
      "X-Device-Simulator": "1",
    },
  });
  socket.on("open", () =>
    process.stdout.write(
      "Simulator voice transport connected; no microphone audio is generated.\n",
    ),
  );
  if (Number(process.env.SIMULATOR_INTERRUPT_AFTER_MS) > 0) {
    socket.once("open", () =>
      setTimeout(() => {
        if (socket?.readyState === WebSocket.OPEN)
          socket.send(
            JSON.stringify({ type: "instruction", msg: "INTERRUPT" }),
          );
      }, Number(process.env.SIMULATOR_INTERRUPT_AFTER_MS)),
    );
  }
  socket.on("message", (raw, binary) => {
    if (binary) return; // No claimed speaker playback. ACK below simulates a completed drain.
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (data.msg === "RESPONSE.CREATED") conversation = "speaking";
    if (data.msg === "RESPONSE.COMPLETE") {
      conversation = "listening";
      if (data.playback_id)
        socket.send(
          JSON.stringify({
            type: "instruction",
            msg: "PLAYBACK.COMPLETE",
            playback_id: data.playback_id,
          }),
        );
    }
    if (data.msg === "AUDIO.CLEAR") conversation = "idle";
  });
  socket.on("close", () => {
    conversation = "idle";
    process.stdout.write("Simulator voice transport closed.\n");
  });
  socket.on("error", () => {
    conversation = "error";
    process.stderr.write(
      "Voice transport failed. Check server configuration.\n",
    );
  });
}
process.on("SIGINT", () => {
  stopped = true;
  socket?.close();
});
try {
  if (statePath) {
    try {
      credentials = JSON.parse(await readFile(statePath, "utf8"));
    } catch {}
  }
  if (credentials?.refreshToken) await refresh();
  else await pair();
  process.stdout.write(
    "SIMULATOR paired. Heartbeats report a simulator; no physical-device verification is claimed.\n",
  );
  if (args.has("--rotate")) {
    credentials = {
      ...credentials,
      ...(await client.call("rotate", { token: credentials.token })),
    };
    await save();
    process.stdout.write("Device credentials rotated.\n");
  }
  if (args.has("--voice")) await connectVoice();
  while (!stopped) {
    if (Date.parse(credentials.expiresAt) - Date.now() < 60000) await refresh();
    const heartbeat = await client.call("heartbeat", {
      token: credentials.token,
      connectionId,
      conversation,
      simulator: true,
      capabilities: ["simulator", "config_ack", "volume"],
    });
    for (const command of heartbeat.commands || []) {
      if (command.expiresAt && Date.parse(command.expiresAt) <= Date.now())
        continue;
      const supported = [
        "config",
        "apply_config",
        "config.update",
        "reconnect",
        "volume",
        "set_volume",
        "speaker_volume",
      ].includes(command.type);
      if (supported) {
        configVersion =
          command.payload?.configVersion ||
          heartbeat.configVersion ||
          configVersion;
        if (command.type === "reconnect") {
          socket?.close();
          if (args.has("--voice")) await connectVoice();
        }
      }
      await client.call("ack", {
        token: credentials.token,
        commandId: command.id,
        status: supported ? "applied" : "failed",
        ...(configVersion ? { configVersion } : {}),
        ...(!supported ? { error: "unsupported_by_simulator" } : {}),
      });
      process.stdout.write(
        `Simulator ${supported ? "applied" : "rejected"} command ${command.type}.\n`,
      );
    }
    if (args.has("--once")) break;
    await sleep(10000);
  }
} catch (error) {
  // Never print server bodies, bootstrap secrets, tokens or provider errors.
  process.stderr.write(
    `Simulator stopped: ${error.code || error.message || "device_error"}\n`,
  );
  process.exitCode = 1;
} finally {
  socket?.close();
}
