import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { Pool } from "pg";

async function main() {
  if (process.env.APP_MODE === "demo")
    throw new Error("Migrations are disabled in demo mode.");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 8000,
  });
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(187654322)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS public.robot_schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const directory = path.join(process.cwd(), "migrations");
    for (const name of (await readdir(directory))
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      const sql = await readFile(path.join(directory, name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const previous = await client.query(
        "SELECT checksum FROM public.robot_schema_migrations WHERE name=$1",
        [name],
      );
      if (previous.rowCount) {
        if (previous.rows[0].checksum !== checksum)
          throw new Error(`Applied migration changed: ${name}`);
        console.log(`Already applied: ${name}`);
        continue;
      }
      await client.query(sql);
      await client.query(
        "INSERT INTO public.robot_schema_migrations(name,checksum) VALUES($1,$2)",
        [name, checksum],
      );
      console.log(`Applied: ${name}`);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(187654322)").catch(() => {});
    client.release();
    await pool.end();
  }
}
main().catch(() => {
  console.error(
    "Migration failed. Verify database access and migration history. No credentials are logged.",
  );
  process.exitCode = 1;
});
