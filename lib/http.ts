import { NextResponse } from "next/server";
import { AppError, isAppError } from "./server/errors";
import { ZodError } from "zod";

export function reply(data: unknown, status = 200) {
  return NextResponse.json(
    { data },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
export function failure(error: unknown) {
  if (error instanceof ZodError)
    return NextResponse.json(
      {
        error: {
          code: "INVALID_INPUT",
          message: error.issues
            .slice(0, 3)
            .map(
              (issue) => `${issue.path.join(".") || "input"}: ${issue.message}`,
            )
            .join("; "),
        },
      },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  if (isAppError(error))
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status, headers: { "Cache-Control": "no-store" } },
    );
  if (error instanceof SyntaxError)
    return NextResponse.json(
      {
        error: {
          code: "INVALID_JSON",
          message: "The request body is not valid JSON.",
        },
      },
      { status: 400 },
    );
  // Never serialize provider errors, database errors, tokens or request bodies.
  return NextResponse.json(
    {
      error: {
        code: "SERVER_ERROR",
        message:
          "The operation could not be completed. Check server configuration and retry.",
      },
    },
    { status: 500 },
  );
}
export function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) {
    // Cookie authenticated browser mutations must have an Origin. Bearer clients
    // (device/server adapters) do not use ambient browser credentials.
    if (request.headers.has("cookie") && !request.headers.has("authorization"))
      throw new AppError(
        "ORIGIN_REQUIRED",
        "A browser origin is required.",
        403,
      );
    return;
  }
  const expected = process.env.APP_BASE_URL || new URL(request.url).origin;
  if (origin !== new URL(expected).origin)
    throw new AppError("ORIGIN_DENIED", "This origin is not allowed.", 403);
}
export async function jsonBody(
  request: Request,
  maxBytes = 1_100_000,
): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maxBytes)
    throw new AppError(
      "BODY_TOO_LARGE",
      "Request exceeds the size limit.",
      413,
    );
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new AppError("CONTENT_TYPE", "Use application/json.", 415);
  const reader = request.body?.getReader();
  if (!reader)
    throw new AppError("BODY_REQUIRED", "A request body is required.");
  const parts: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new AppError(
        "BODY_TOO_LARGE",
        "Request exceeds the size limit.",
        413,
      );
    }
    parts.push(value);
  }
  const value = JSON.parse(Buffer.concat(parts).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError("INVALID_BODY", "Expected a JSON object.");
  return value;
}
