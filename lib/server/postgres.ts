import { Pool } from "pg";
import { AppError } from "./errors";
import { emptyState, type State, type StateStore } from "./state";

const tables = [
  ["workspaces", "robot_workspaces"],
  ["members", "robot_workspace_members"],
  ["devices", "robot_devices"],
  ["templates", "robot_character_templates"],
  ["sessions", "robot_conversation_sessions"],
  ["audit", "robot_audit_logs"],
  ["identities", "robot_bootstrap_identities"],
  ["claims", "robot_pairing_requests"],
  ["credentials", "robot_device_credentials"],
  ["jobs", "robot_ingestion_jobs"],
  ["vectorStores", "robot_vector_stores"],
  ["rateLimits", "robot_rate_limits"],
] as const;

/** Small-installation repository. The transaction advisory lock serializes all state
 * transitions across workers; network/provider calls never run under this lock. */
export class PostgresStore implements StateStore {
  private pool: Pool;
  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 5,
      connectionTimeoutMillis: 8000,
      idleTimeoutMillis: 30000,
    });
  }
  async close() {
    await this.pool.end();
  }
  async transaction<T>(
    operation: (state: State) => T | Promise<T>,
  ): Promise<T> {
    let client;
    try {
      client = await this.pool.connect();
    } catch {
      throw new AppError(
        "DATABASE_UNAVAILABLE",
        "Database unavailable. Check the server database configuration.",
        503,
      );
    }
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(187654321)");
      const state = emptyState();
      for (const [key, table] of tables) {
        const result = await client.query(`SELECT payload FROM ${table}`);
        (state[key] as unknown[]) = result.rows.map((row) => row.payload);
      }
      const before = structuredClone(state);
      const result = await operation(state);
      validateState(state);
      // Upsert parents before children. Payloads contain only server-visible data.
      for (const [key, table] of tables) {
        const old = new Map(
          (before[key] as unknown[]).map((value) => {
            const row = value as Record<string, unknown>;
            return [rowKey(key, row), JSON.stringify(row)];
          }),
        );
        for (const value of state[key] as unknown[]) {
          const row = value as Record<string, unknown>;
          const id = rowKey(key, row);
          const json = JSON.stringify(row);
          if (old.get(id) === json) continue;
          const columns = ["id", "payload"];
          const values: unknown[] = [id, json];
          if (
            [
              "devices",
              "templates",
              "sessions",
              "audit",
              "claims",
              "credentials",
              "jobs",
              "vectorStores",
              "members",
            ].includes(key)
          ) {
            columns.push("workspace_id");
            values.push(row.workspaceId);
          }
          if (
            [
              "sessions",
              "claims",
              "credentials",
              "jobs",
              "vectorStores",
            ].includes(key)
          ) {
            columns.push("device_id");
            values.push(row.deviceId);
          }
          if (key === "devices") {
            columns.push("mac", "paired");
            values.push(row.mac, row.provisioning === "paired");
          }
          if (key === "members") {
            columns.push("user_id", "role");
            values.push(row.userId, row.role);
          }
          const update = columns
            .slice(1)
            .map((column) => `${column}=EXCLUDED.${column}`)
            .join(",");
          await client.query(
            `INSERT INTO ${table} (${columns.join(",")}) VALUES (${values.map((_, i) => `$${i + 1}`).join(",")}) ON CONFLICT(id) DO UPDATE SET ${update}`,
            values,
          );
        }
      }
      // Delete children first. Ordinary archival avoids deleting device parents.
      for (const [key, table] of [...tables].reverse()) {
        const current = new Set(
          (state[key] as unknown[]).map((value) =>
            rowKey(key, value as Record<string, unknown>),
          ),
        );
        for (const value of before[key] as unknown[]) {
          const id = rowKey(key, value as Record<string, unknown>);
          if (!current.has(id))
            await client.query(`DELETE FROM ${table} WHERE id=$1`, [id]);
        }
      }
      await client.query("COMMIT");
      return structuredClone(result);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (error instanceof AppError) throw error;
      const code = (error as { code?: string }).code;
      if (code === "23505")
        throw new AppError(
          "CONFLICT",
          "This device or record is unavailable.",
          409,
        );
      if (code === "42P01")
        throw new AppError(
          "SETUP_REQUIRED",
          "Database migration is required.",
          503,
        );
      throw error;
    } finally {
      client.release();
    }
  }
}
function rowKey(key: keyof State, row: Record<string, unknown>): string {
  if (key === "identities") return String(row.mac);
  if (key === "members") return `${row.workspaceId}:${row.userId}`;
  if (key === "vectorStores") return String(row.deviceId);
  if (key === "rateLimits") return String(row.key);
  return String(row.id);
}
export function validateState(state: State) {
  const workspaces = new Set(state.workspaces.map((row) => row.id));
  for (const device of state.devices)
    if (!workspaces.has(device.workspaceId))
      throw new AppError("INVALID_STATE", "Unknown workspace.", 500);
  for (const row of [
    ...state.sessions,
    ...state.claims,
    ...state.credentials,
    ...state.jobs,
    ...state.vectorStores,
  ]) {
    if (
      !state.devices.some(
        (device) =>
          device.id === row.deviceId && device.workspaceId === row.workspaceId,
      )
    )
      throw new AppError(
        "INVALID_STATE",
        "Invalid workspace and device association.",
        500,
      );
  }
}
