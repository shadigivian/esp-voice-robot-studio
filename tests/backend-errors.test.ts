import test from "node:test";
import assert from "node:assert/strict";
import { AppError, isAppError } from "../lib/server/errors";
import { publicVoiceEndpoint } from "../lib/server/service";

test("application errors retain their classification across module copies without trusting plain objects", () => {
  assert(
    isAppError(new AppError("FORBIDDEN", "Workspace access denied.", 403)),
  );
  const foreign = Object.assign(new Error("Denied"), {
    code: "FORBIDDEN",
    status: 403,
    [Symbol.for("esp-voice-management.AppError")]: true,
  });
  assert(isAppError(foreign));
  assert.equal(
    isAppError({
      name: "AppError",
      code: "FORBIDDEN",
      message: "Untrusted",
      status: 403,
    }),
    false,
  );
});
test("integration endpoint output excludes URL credentials, query tokens and fragments", () => {
  assert.equal(
    publicVoiceEndpoint("wss://voice.example/managed-voice"),
    "wss://voice.example/managed-voice",
  );
  for (const url of [
    "wss://user:password@voice.example/managed-voice",
    "wss://voice.example/managed-voice?token=private",
    "wss://voice.example/managed-voice#private",
    "file:///private",
    "not a URL",
  ])
    assert.equal(publicVoiceEndpoint(url), null);
});
