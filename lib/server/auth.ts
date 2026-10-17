import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { Actor } from "../domain";
import { AppError, assert } from "./errors";
import { getService } from "./service";

export const DEMO_COOKIE = "robot_demo_session";
export const ACCESS_COOKIE = "robot_access_token";
const runtime = globalThis as typeof globalThis & { robotDemoSecret?: string };
function signingSecret() {
  runtime.robotDemoSecret ??=
    process.env.DEMO_SESSION_SECRET || randomBytes(32).toString("hex");
  return runtime.robotDemoSecret;
}
function signature(body: string) {
  return createHmac("sha256", signingSecret()).update(body).digest("base64url");
}
function cookies(request: Request) {
  return Object.fromEntries(
    (request.headers.get("cookie") || "").split(";").map((part) => {
      const i = part.indexOf("=");
      return i < 0
        ? ["", ""]
        : [part.slice(0, i).trim(), part.slice(i + 1).trim()];
    }),
  );
}
function demoPayload(token: string): {
  userId: string;
  workspaceId: string;
  exp: number;
} {
  const [body, provided] = token.split(".");
  assert(
    body && provided,
    "UNAUTHORIZED",
    "Demo session is missing or expired.",
    401,
  );
  const expected = signature(body);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  assert(
    a.length === b.length && timingSafeEqual(a, b),
    "UNAUTHORIZED",
    "Invalid demo session.",
    401,
  );
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    assert(
      typeof parsed.userId === "string" &&
        typeof parsed.workspaceId === "string" &&
        parsed.exp > Date.now(),
      "UNAUTHORIZED",
      "Demo session expired.",
      401,
    );
    return parsed;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("UNAUTHORIZED", "Invalid demo session.", 401);
  }
}
export async function createDemoSession() {
  assert(
    process.env.APP_MODE === "demo",
    "FORBIDDEN",
    "Demo mode is not enabled.",
    403,
  );
  const service = getService();
  const actor = await service.createWorkspace(
    randomUUID(),
    "فضای نمایشی خصوصی",
  );
  await service.seedDemo(actor);
  const body = Buffer.from(
    JSON.stringify({
      userId: actor.userId,
      workspaceId: actor.workspaceId,
      exp: Date.now() + 8 * 3600000,
    }),
  ).toString("base64url");
  return { token: `${body}.${signature(body)}`, actor };
}
export async function endDemoSession(token: string) {
  if (process.env.APP_MODE !== "demo" || !token) return;
  try {
    const payload = demoPayload(token);
    await getService().store.transaction((state) => {
      state.members = state.members.filter(
        (row) =>
          row.workspaceId !== payload.workspaceId ||
          row.userId !== payload.userId,
      );
    });
  } catch {
    /* logout is idempotent */
  }
}
function supabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  assert(
    url && anon,
    "SETUP_REQUIRED",
    "Configure SUPABASE_URL and SUPABASE_ANON_KEY on the server.",
    503,
  );
  const parsed = new URL(url);
  assert(
    parsed.protocol === "https:" ||
      (process.env.NODE_ENV !== "production" &&
        ["localhost", "127.0.0.1"].includes(parsed.hostname)),
    "SETUP_REQUIRED",
    "Supabase requires an HTTPS endpoint in production.",
    503,
  );
  return { url: parsed.origin, anon };
}
export async function loginWithPassword(email: string, password: string) {
  const config = supabaseConfig();
  const response = await fetch(
    `${config.url}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: { apikey: config.anon, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    },
  );
  assert(
    response.ok,
    "LOGIN_FAILED",
    "Sign in failed. Check your email and password.",
    401,
  );
  const result = await response.json();
  assert(
    result.access_token,
    "LOGIN_FAILED",
    "Authentication did not issue a session.",
    401,
  );
  return {
    accessToken: result.access_token as string,
    refreshToken: result.refresh_token as string,
    expiresIn: Number(result.expires_in || 3600),
  };
}
export async function refreshUserSession(refreshToken: string) {
  const config = supabaseConfig();
  const response = await fetch(
    `${config.url}/auth/v1/token?grant_type=refresh_token`,
    {
      method: "POST",
      headers: { apikey: config.anon, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    },
  );
  assert(response.ok, "UNAUTHORIZED", "Sign in again.", 401);
  const result = await response.json();
  assert(
    typeof result.access_token === "string" &&
      typeof result.refresh_token === "string",
    "UNAUTHORIZED",
    "Sign in again.",
    401,
  );
  return {
    accessToken: result.access_token as string,
    refreshToken: result.refresh_token as string,
    expiresIn: Number(result.expires_in || 3600),
  };
}
export async function authenticateRequest(request: Request): Promise<Actor> {
  const cookie = cookies(request);
  const service = getService();
  if (process.env.APP_MODE === "demo") {
    const payload = demoPayload(cookie[DEMO_COOKIE] || "");
    return service.memberActor(payload.userId, payload.workspaceId);
  }
  const token =
    request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ||
    cookie[ACCESS_COOKIE];
  assert(token, "UNAUTHORIZED", "Sign in to continue.", 401);
  const config = supabaseConfig();
  const response = await fetch(`${config.url}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: config.anon },
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  assert(
    response.ok,
    "UNAUTHORIZED",
    "Your session has expired. Sign in again.",
    401,
  );
  const user = await response.json();
  assert(
    typeof user.id === "string",
    "UNAUTHORIZED",
    "Invalid authentication response.",
    401,
  );
  return service.memberActor(
    user.id,
    request.headers.get("x-workspace-id") || undefined,
  );
}
