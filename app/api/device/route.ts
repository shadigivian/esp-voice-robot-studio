import { getService } from "@/lib/server/service";
import { failure, jsonBody, reply } from "@/lib/http";
import { AppError } from "@/lib/server/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    // This is a device/server endpoint, never ambient cookie authentication.
    if (request.headers.has("origin"))
      throw new AppError(
        "BROWSER_DENIED",
        "Use the authenticated management application.",
        403,
      );
    if (
      process.env.NODE_ENV === "production" &&
      process.env.APP_MODE !== "demo" &&
      !process.env.APP_BASE_URL?.startsWith("https://")
    )
      throw new AppError(
        "TLS_REQUIRED",
        "APP_BASE_URL must use HTTPS in production.",
        503,
      );
    const body = await jsonBody(request);
    const bearer = request.headers.get("authorization");
    const token = bearer?.startsWith("Bearer ") ? bearer.slice(7) : undefined;
    const { adapterSecret: _untrustedSecret, ...input } = body;
    const adapterSecret =
      request.headers.get("x-management-adapter-key") || undefined;
    return reply(
      await getService().device({
        ...input,
        ...(token ? { token } : {}),
        ...(adapterSecret ? { adapterSecret } : {}),
      }),
    );
  } catch (error) {
    return failure(error);
  }
}
