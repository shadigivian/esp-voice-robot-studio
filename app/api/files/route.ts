import { authenticateRequest } from "@/lib/server/auth";
import { getService } from "@/lib/server/service";
import { readOriginal } from "@/lib/private-files";
import { failure } from "@/lib/http";
import { AppError } from "@/lib/server/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const actor = await authenticateRequest(request);
    const query = new URL(request.url).searchParams;
    const deviceId = query.get("deviceId") || "";
    const documentId = query.get("documentId") || "";
    const data = await getService().bootstrap(actor);
    if (
      !data.devices.some(
        (device) =>
          device.id === deviceId &&
          device.documents.some(
            (document) =>
              document.id === documentId && document.status !== "deleted",
          ),
      )
    )
      throw new AppError("NOT_FOUND", "Document not found.", 404);
    const file = await readOriginal(actor, deviceId, documentId);
    // A delete or membership revocation may occur while the disk read is pending.
    await getService().authorizeDocument(actor, deviceId, documentId);
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        "Content-Type": file.meta.mime,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.meta.name)}`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return failure(error);
  }
}
