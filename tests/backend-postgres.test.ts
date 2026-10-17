import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgresStore } from "../lib/server/postgres";
import { ControlService } from "../lib/server/service";

test(
  "PostgreSQL multi-worker mutations serialize and composite device/workspace validation holds",
  {
    skip: !process.env.TEST_DATABASE_URL
      ? "TEST_DATABASE_URL is not set; requires an explicitly chosen migrated test database."
      : false,
  },
  async () => {
    const a = new PostgresStore(process.env.TEST_DATABASE_URL!);
    const b = new PostgresStore(process.env.TEST_DATABASE_URL!);
    const first = new ControlService(a);
    const second = new ControlService(b);
    const actor = await first.createWorkspace(
      randomUUID(),
      "Opt-in PostgreSQL test",
    );
    try {
      await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          (index % 2 ? first : second).control(actor, {
            action: "save_template",
            name: `Concurrent ${index}`,
            character: {
              name: "Test",
              description: "",
              icon: "*",
              tone: "friendly",
              patience: "high",
              humor: "low",
              responseLength: "short",
              language: "en",
              languages: ["en"],
              voice: "",
              greeting: "AI assistant",
              instructions: "",
            },
          }),
        ),
      );
      assert.equal((await first.bootstrap(actor)).templates.length, 10);
      await assert.rejects(
        a.transaction((state) => {
          state.sessions.push({
            id: randomUUID(),
            workspaceId: actor.workspaceId,
            deviceId: randomUUID(),
            type: "test",
            startedAt: new Date().toISOString(),
            endedAt: null,
            configVersion: 1,
            knowledgeEpoch: 0,
            status: "active",
            transcriptStored: false,
            messages: [],
            error: null,
            usage: null,
          });
        }),
        /association/,
      );
    } finally {
      await a.transaction((state) => {
        state.templates = state.templates.filter(
          (row) => row.workspaceId !== actor.workspaceId,
        );
        state.audit = state.audit.filter(
          (row) => row.workspaceId !== actor.workspaceId,
        );
        state.members = state.members.filter(
          (row) => row.workspaceId !== actor.workspaceId,
        );
        state.workspaces = state.workspaces.filter(
          (row) => row.id !== actor.workspaceId,
        );
      });
      await a.close();
      await b.close();
    }
  },
);
