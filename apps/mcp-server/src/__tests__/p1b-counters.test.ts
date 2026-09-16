import { describe, it, expect } from "vitest";
import { insertMessagesWithCount } from "@getengram/db";
import { reconcileOrgCounters } from "@getengram/db";

// P1b: the counter-drift class. These pin that (a) message inserts and the
// conversation message_count bump commit in ONE batch (they can't diverge),
// and (b) reconcileOrgCounters recomputes both org counters from live COUNTs.

function captureDb() {
  const batches: { sql: string; args: unknown[] }[][] = [];
  const singles: { sql: string; args: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind: (...args: unknown[]) => {
          const stmt = { sql, args };
          return { ...stmt, run: async () => { singles.push(stmt); return { meta: {} }; } };
        },
      };
    },
    async batch(stmts: { sql: string; args: unknown[] }[]) {
      batches.push(stmts);
      return [];
    },
  } as unknown as D1Database;
  return { db, batches, singles };
}

describe("insertMessagesWithCount", () => {
  it("commits the inserts and the count bump in a single atomic batch", async () => {
    const { db, batches } = captureDb();
    await insertMessagesWithCount(
      db,
      [
        { id: "m1", conversationId: "c1", organizationId: "o1", role: "user", content: "a", contentEncoding: null, toolCallId: null, toolName: null, sequence: 1, metadata: {} },
        { id: "m2", conversationId: "c1", organizationId: "o1", role: "assistant", content: "b", contentEncoding: null, toolCallId: null, toolName: null, sequence: 2, metadata: {} },
      ],
      "c1",
    );
    expect(batches).toHaveLength(1);
    const batch = batches[0];
    const inserts = batch.filter((s) => s.sql.startsWith("INSERT INTO messages"));
    const countUpd = batch.filter((s) => s.sql.includes("message_count = message_count + ?"));
    expect(inserts).toHaveLength(2);
    expect(countUpd).toHaveLength(1);
    // The bump matches the number of messages inserted.
    expect(countUpd[0].args[0]).toBe(2);
    expect(countUpd[0].args[1]).toBe("c1");
  });
});

describe("reconcileOrgCounters", () => {
  it("sets both counters from live COUNT(*) for the org", async () => {
    const { db, singles } = captureDb();
    await reconcileOrgCounters(db, "org_x");
    const stmt = singles[0];
    expect(stmt.sql).toContain("messages_stored_total = (SELECT COUNT(*) FROM messages");
    expect(stmt.sql).toContain("conversation_count = (SELECT COUNT(*) FROM conversations");
    expect(stmt.args).toEqual(["org_x", "org_x", "org_x"]);
  });
});
