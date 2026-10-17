import { getService } from "../lib/server/service";
import { cleanupDeletedOriginals } from "../lib/private-files";
import { cleanupBrowserVoiceCalls } from "../lib/browser-voice";

let stopped = false;
process.once("SIGINT", () => {
  stopped = true;
});
process.once("SIGTERM", () => {
  stopped = true;
});
async function main() {
  const service = getService();
  if (service.demo)
    throw new Error("Demo ingestion is synchronous; do not run a real worker.");
  console.log(
    "Knowledge and retention worker started. Document contents and secrets are never logged.",
  );
  try {
    while (!stopped) {
      // Retention runs even when a provider key is missing or indexing is failing.
      await service.cleanupRetention();
      await cleanupDeletedOriginals();
      await cleanupBrowserVoiceCalls();
      if (process.env.OPENAI_API_KEY) {
        const result = await service.processJobs(5);
        if (result.processed)
          console.log(
            `Ingestion: processed=${result.processed}, ready=${result.ready}, failed=${result.failed}`,
          );
      }
      if (process.argv.includes("--once")) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  } finally {
    await service.store.close?.();
  }
}
main().catch(() => {
  console.error(
    "Worker stopped. Check database, migration and provider configuration.",
  );
  process.exitCode = 1;
});
