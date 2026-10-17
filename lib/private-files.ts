import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Actor } from "./domain";
import { AppError } from "./server/errors";
import { getService } from "./server/service";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function filePath(actor: Actor, deviceId: string, documentId: string) {
  if (
    ![actor.workspaceId, deviceId, documentId].every((value) =>
      uuid.test(value),
    )
  )
    throw new AppError("INVALID_ID", "Invalid file identifier.");
  // Never served by Next's public directory; route authorizes before access.
  const mode = process.env.APP_MODE === "demo" ? "demo" : "production";
  return path.join(
    path.resolve(process.env.PRIVATE_STORAGE_DIR || ".local/private-files"),
    mode,
    actor.workspaceId,
    deviceId,
    documentId,
  );
}
export async function saveOriginal(
  actor: Actor,
  deviceId: string,
  documentId: string,
  bytes: Uint8Array,
  name: string,
  mime: string,
) {
  const target = filePath(actor, deviceId, documentId);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  let created = false;
  try {
    await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
    created = true;
    await writeFile(`${target}.json`, JSON.stringify({ name, mime }), {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if (created) {
      await rm(target, { force: true }).catch(() => {});
      await rm(`${target}.json`, { force: true }).catch(() => {});
    }
    throw error;
  }
}
export async function readOriginal(
  actor: Actor,
  deviceId: string,
  documentId: string,
) {
  const target = filePath(actor, deviceId, documentId);
  try {
    return {
      bytes: await readFile(target),
      meta: JSON.parse(await readFile(`${target}.json`, "utf8")) as {
        name: string;
        mime: string;
      },
    };
  } catch {
    throw new AppError(
      "FILE_UNAVAILABLE",
      "The original file is unavailable. The reviewed text remains in the document.",
      404,
    );
  }
}
export async function deleteOriginal(
  actor: Actor,
  deviceId: string,
  documentId: string,
) {
  const target = filePath(actor, deviceId, documentId);
  await rm(target, { force: true });
  await rm(`${target}.json`, { force: true });
}
export async function cleanupDeletedOriginals() {
  const deleted = await getService().store.transaction((state) =>
    state.devices.flatMap((device) =>
      device.documents
        .filter((doc) => doc.status === "deleted")
        .map((doc) => ({
          workspaceId: device.workspaceId,
          deviceId: device.id,
          documentId: doc.id,
        })),
    ),
  );
  for (const row of deleted)
    try {
      await deleteOriginal(
        {
          userId: "private-file-cleanup",
          workspaceId: row.workspaceId,
          role: "owner",
        },
        row.deviceId,
        row.documentId,
      );
    } catch {
      /* retry next worker cycle */
    }
}
