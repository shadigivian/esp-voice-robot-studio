import { z } from "zod";
import { getService } from "../lib/server/service";

async function main() {
  const service = getService();
  const [action, ...values] = process.argv.slice(2);
  if (service.demo)
    throw new Error("Operator enrollment is disabled in demo mode.");
  try {
    if (action === "workspace") {
      const userId = z.string().uuid().parse(values[0]);
      const name = z.string().min(1).max(200).parse(values.slice(1).join(" "));
      const actor = await service.createWorkspace(userId, name);
      console.log(`Workspace created: ${actor.workspaceId}`);
    } else if (action === "provision") {
      if (!process.env.DEVICE_BOOTSTRAP_SECRET)
        throw new Error(
          "Set DEVICE_BOOTSTRAP_SECRET in the operator environment.",
        );
      await service.provision(
        values[0] || "",
        process.env.DEVICE_BOOTSTRAP_SECRET,
      );
      console.log(
        "Unique bootstrap identity registered. Secret was hashed and is not displayed.",
      );
    } else if (action === "member") {
      const workspaceId = z.string().uuid().parse(values[0]);
      const userId = z.string().uuid().parse(values[1]);
      const role = z.enum(["owner", "admin", "viewer"]).parse(values[2]);
      await service.store.transaction((state) => {
        if (!state.workspaces.some((row) => row.id === workspaceId))
          throw new Error("Workspace not found.");
        const member = state.members.find(
          (row) => row.workspaceId === workspaceId && row.userId === userId,
        );
        if (member) member.role = role;
        else state.members.push({ workspaceId, userId, role });
      });
      console.log("Workspace membership updated.");
    } else
      throw new Error(
        "Usage: operator workspace USER_UUID NAME | provision STATION_MAC | member WORKSPACE_UUID USER_UUID owner|admin|viewer",
      );
  } finally {
    await service.store.close?.();
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error && error.message.startsWith("Usage:")
      ? error.message
      : "Enrollment failed. Verify identifiers, server configuration and operator environment. No secrets are displayed.",
  );
  process.exitCode = 1;
});
