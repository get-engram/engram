import { describe, it, expect } from "vitest";
import { seedWelcomeConversation } from "../routes/signup.js";

// Regression coverage for the welcome seed skipping the invariants that
// createConversation/appendMessages maintain. Because it wrote the
// conversation and message rows directly, every org that ever signed up
// ended up short by exactly one message and one conversation: 984 of 1345
// production orgs were undercounted by 1 on messages_stored_total, and 1162
// on conversation_count. messages_stored_total is the lifetime storage cap
// (engram#275) — the billing gate — so the drift meant the cap silently
// under-enforced and disagreed with what memory_status reported back.
//
// Both signup routes (POST /signup and the OAuth connector flow) call this,
// which is why the drift was close to universal.

interface Captured {
  sql: string;
  args: unknown[];
}

function captureDb(): { db: D1Database; statements: Captured[] } {
  const statements: Captured[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          const stmt = { sql, args };
          return stmt;
        },
      };
    },
    async batch(stmts: Captured[]) {
      statements.push(...stmts);
      return [];
    },
  } as unknown as D1Database;
  return { db, statements: statements };
}

describe("seedWelcomeConversation", () => {
  it("bumps both org counters so they match the rows it inserts", async () => {
    const { db, statements } = captureDb();
    await seedWelcomeConversation(db, "org_abc");

    const counterUpdate = statements.find(
      (s) => s.sql.includes("UPDATE organizations") && s.sql.includes("messages_stored_total"),
    );
    expect(counterUpdate, "welcome seed must maintain the org counters").toBeDefined();
    expect(counterUpdate!.sql).toContain("conversation_count = conversation_count + 1");
    expect(counterUpdate!.sql).toContain("messages_stored_total = messages_stored_total + 1");
    expect(counterUpdate!.args).toEqual(["org_abc"]);

    // Exactly one conversation row and one message row, so +1/+1 is right.
    const convInserts = statements.filter((s) => s.sql.startsWith("INSERT INTO conversations"));
    const msgInserts = statements.filter((s) => s.sql.startsWith("INSERT INTO messages"));
    expect(convInserts).toHaveLength(1);
    expect(msgInserts).toHaveLength(1);
  });

  it("populates the conversation_tags index for every tag on the row", async () => {
    const { db, statements } = captureDb();
    await seedWelcomeConversation(db, "org_abc");

    const conv = statements.find((s) => s.sql.startsWith("INSERT INTO conversations"))!;
    const tagsOnRow = JSON.parse(conv.args[4] as string) as string[];

    const tagInserts = statements.filter((s) => s.sql.includes("INTO conversation_tags"));
    expect(tagInserts.map((s) => s.args[2]).sort()).toEqual([...tagsOnRow].sort());
    // Tag rows must point at the conversation that was actually inserted.
    for (const t of tagInserts) {
      expect(t.args[0]).toBe(conv.args[0]);
      expect(t.args[1]).toBe("org_abc");
    }
  });

  it("does all of it in a single batch, so counters cannot diverge from rows", async () => {
    let batches = 0;
    const db = {
      prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({ sql, args }) }),
      batch: async () => {
        batches++;
        return [];
      },
    } as unknown as D1Database;

    await seedWelcomeConversation(db, "org_abc");
    expect(batches).toBe(1);
  });
});
