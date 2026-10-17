import { authenticateRequest } from "@/lib/server/auth";
import { getService } from "@/lib/server/service";
import { checkOrigin, failure, reply } from "@/lib/http";
import { extractFile, safeFilename, uploadLimit } from "@/lib/extract";
import { saveOriginal, deleteOriginal } from "@/lib/private-files";
import { AppError, isAppError } from "@/lib/server/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const actor = await authenticateRequest(request);
    if (actor.role === "viewer")
      throw new AppError("FORBIDDEN", "Administrator access is required.", 403);
    await getService().rateLimit(`upload:${actor.userId}`, 10, 60_000);
    await getService().rateLimit("upload:global", 30, 60_000);
    const maximum = uploadLimit() + 64 * 1024;
    if (Number(request.headers.get("content-length") || 0) > maximum)
      throw new AppError("UPLOAD_LIMIT", "Upload exceeds the size limit.", 413);
    const deviceId = new URL(request.url).searchParams.get("deviceId");
    if (!deviceId)
      throw new AppError("DEVICE_REQUIRED", "Select the destination device.");
    // Authorize destination before doing parser/storage/provider work.
    const bootstrap = await getService().bootstrap(actor);
    if (!bootstrap.devices.some((device) => device.id === deviceId))
      throw new AppError("NOT_FOUND", "Device not found.", 404);
    const reader = request.body?.getReader();
    if (!reader) throw new AppError("FILE_REQUIRED", "Select a file.");
    const parts: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new AppError(
          "UPLOAD_LIMIT",
          "Upload exceeds the size limit.",
          413,
        );
      }
      parts.push(value);
    }
    const form = await new Response(Buffer.concat(parts), {
      headers: { "Content-Type": request.headers.get("content-type") || "" },
    }).formData();
    const file = form.get("file");
    if (!file || typeof file === "string" || !("arrayBuffer" in file))
      throw new AppError("FILE_REQUIRED", "Select a file.");
    const name = safeFilename(file.name);
    const bytes = new Uint8Array(await file.arrayBuffer());
    let extracted: Awaited<ReturnType<typeof extractFile>>;
    try {
      extracted = await extractFile(bytes, name, file.type);
    } catch (error) {
      if (
        isAppError(error) &&
        [
          "PDF_ENCRYPTED",
          "PDF_UNREADABLE",
          "PDF_PARSER_ERROR",
          "PDF_TIMEOUT",
          "PDF_PAGE_LIMIT",
          "TEXT_LIMIT",
        ].includes(error.code) &&
        name.toLowerCase().endsWith(".pdf")
      ) {
        return reply(
          await getService().control(actor, {
            action: "add_document",
            deviceId,
            title: name,
            text: "",
            mimeType: file.type,
            originalName: name,
            extractionError: `${error.code}: ${error.message}`,
          }),
          201,
        );
      }
      throw error;
    }
    const data = await getService().control(actor, {
      action: "add_document",
      deviceId,
      title: String(form.get("title") || name).slice(0, 200),
      text: extracted.text,
      mimeType: file.type,
      originalName: name,
      ...(extracted.warning ? { extractionError: extracted.warning } : {}),
    });
    const document = data as { documentId?: string };
    let originalWarning: string | undefined;
    if (document.documentId)
      try {
        await saveOriginal(
          actor,
          deviceId,
          document.documentId,
          bytes,
          name,
          file.type,
        );
      } catch {
        originalWarning =
          "The reviewed text was saved, but the original file could not be retained. Retry by uploading a replacement if the original is required.";
      }
    if (document.documentId)
      try {
        await getService().authorizeDocument(
          actor,
          deviceId,
          document.documentId,
        );
      } catch (error) {
        await deleteOriginal(actor, deviceId, document.documentId).catch(
          () => {},
        );
        throw error;
      }
    return reply(
      { ...data, ...(originalWarning ? { warning: originalWarning } : {}) },
      201,
    );
  } catch (error) {
    return failure(error);
  }
}
