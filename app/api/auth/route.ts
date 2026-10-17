import { cookies } from "next/headers";
import {
  authenticateRequest,
  createDemoSession,
  endDemoSession,
  loginWithPassword,
  refreshUserSession,
} from "@/lib/server/auth";
import { AppError } from "@/lib/server/errors";
import { getService } from "@/lib/server/service";
import { createHash } from "node:crypto";
import { checkOrigin, failure, jsonBody, reply } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const options = () => {
  const secure = process.env.APP_BASE_URL?.startsWith("https://") ?? false;
  if (
    process.env.NODE_ENV === "production" &&
    process.env.APP_MODE !== "demo" &&
    !secure
  )
    throw new AppError(
      "TLS_REQUIRED",
      "Configure an HTTPS APP_BASE_URL before production sign in.",
      503,
    );
  return { httpOnly: true, secure, sameSite: "strict" as const, path: "/" };
};
export async function GET() {
  return reply({
    demo: process.env.APP_MODE === "demo",
    configured: !!(
      process.env.SUPABASE_URL &&
      process.env.SUPABASE_ANON_KEY &&
      process.env.DATABASE_URL
    ),
    productName: process.env.PRODUCT_NAME || "پنل ربات‌های صوتی",
  });
}
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const body = await jsonBody(request, 4096);
    await getService().rateLimit("auth:global", 100, 60_000);
    const loginId = createHash("sha256")
      .update(String(body.email || "demo").toLowerCase())
      .digest("hex");
    await getService().rateLimit(`auth:${loginId}`, 8, 60_000);
    const jar = await cookies();
    options();
    if (body.demo === true) {
      if (process.env.APP_MODE !== "demo")
        throw new AppError("DEMO_DISABLED", "Demo is not enabled.", 403);
      const session = await createDemoSession();
      jar.set("robot_demo_session", session.token, {
        ...options(),
        maxAge: 4 * 60 * 60,
      });
      return reply({ demo: true });
    }
    if (
      typeof body.email !== "string" ||
      typeof body.password !== "string" ||
      body.email.length > 254 ||
      body.password.length > 1024
    )
      throw new AppError("INVALID_LOGIN", "Enter your email and password.");
    const result = await loginWithPassword(body.email, body.password);
    jar.set("robot_access_token", result.accessToken, {
      ...options(),
      maxAge: result.expiresIn,
    });
    jar.set("robot_refresh_token", result.refreshToken, {
      ...options(),
      maxAge: 7 * 24 * 60 * 60,
      path: "/api/auth",
    });
    return reply({ authenticated: true });
  } catch (error) {
    return failure(error);
  }
}
export async function DELETE(request: Request) {
  try {
    checkOrigin(request);
    const jar = await cookies();
    try {
      const actor = await authenticateRequest(request);
      await getService().endUserBrowserSessions(actor);
    } catch {
      /* Local sign out still succeeds after cookie/session expiry. */
    }
    const demo = jar.get("robot_demo_session")?.value;
    if (demo) await endDemoSession(demo);
    jar.delete("robot_demo_session");
    jar.delete("robot_access_token");
    jar.set("robot_refresh_token", "", {
      ...options(),
      path: "/api/auth",
      maxAge: 0,
    });
    return reply({ authenticated: false });
  } catch (error) {
    return failure(error);
  }
}
export async function PUT(request: Request) {
  try {
    checkOrigin(request);
    const jar = await cookies();
    const token = jar.get("robot_refresh_token")?.value;
    if (!token || !process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY)
      throw new AppError("UNAUTHORIZED", "Sign in again.", 401);
    await getService().rateLimit(
      `refresh:${createHash("sha256").update(token).digest("hex")}`,
      8,
      60_000,
    );
    options();
    const result = await refreshUserSession(token);
    jar.set("robot_access_token", result.accessToken, {
      ...options(),
      maxAge: result.expiresIn,
    });
    jar.set("robot_refresh_token", result.refreshToken, {
      ...options(),
      maxAge: 7 * 24 * 60 * 60,
      path: "/api/auth",
    });
    return reply({ authenticated: true });
  } catch (error) {
    return failure(error);
  }
}
