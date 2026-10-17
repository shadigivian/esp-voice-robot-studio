import { authenticateRequest } from "@/lib/server/auth";
import { getService } from "@/lib/server/service";
import { checkOrigin, failure, jsonBody, reply } from "@/lib/http";
import { deleteOriginal } from "@/lib/private-files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    return reply(
      await getService().bootstrap(await authenticateRequest(request)),
    );
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const actor = await authenticateRequest(request);
    const input = await jsonBody(request);
    const data = await getService().control(actor, input);
    // Logical access is revoked transactionally first. Disk cleanup can be retried.
    if (
      input.action === "delete_document" &&
      typeof input.deviceId === "string" &&
      typeof input.documentId === "string"
    )
      await deleteOriginal(actor, input.deviceId, input.documentId);
    return reply(data);
  } catch (error) {
    return failure(error);
  }
}
