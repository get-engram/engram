import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import { applyMigration } from "./miniflare.js";
import {
  getOrCreateUsage,
  getUsage,
  atomicIncrementChunksIndexed,
  atomicIncrementSearches,
  atomicIncrementMessages,
  incrementChunksIndexed,
  releaseMessagesStored,
  releaseChunksIndexed,
} from "@getengram/db";

/**
 * The cost budgets (engram#445/#450/#451) rest on one SQLite property: an
 * UPDATE guarded by `counter + ? <= ?` with RETURNING hands back the new
 * value when it applied and no row when the guard failed — and leaves the
 * counter untouched in that case. The mock D1 in helpers.ts models that
 * shape; this file proves the real queries do it against real SQLite,
 * with the real usage migrations applied (0022 + 0044 on top of 0003's
 * table — 0003 itself drags in seats/webhooks/organizations ALTERs the
 * budgets do not need).
 */

// 0003's usage table, verbatim (the rest of 0003 is unrelated to this test).
const USAGE_TABLE_0003 = `CREATE TABLE IF NOT EXISTS usage (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  period TEXT NOT NULL,
  messages_stored INTEGER NOT NULL DEFAULT 0,
  searches_run INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  UNIQUE(organization_id, period)
)`;

type UsageRow = {
  id: string;
  messages_stored: number;
  searches_run: number;
  api_requests: number;
  chunks_indexed: number;
};

describe("usage cost counters against real SQLite", () => {
  let mf: Miniflare;
  let db: D1Database;
  let seq = 0;

  async function org(): Promise<string> {
    const id = `org_q${++seq}`;
    await db.prepare("INSERT INTO organizations (id) VALUES (?)").bind(id).run();
    return id;
  }

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "usage-quotas-test" },
    });
    db = (await mf.getD1Database("DB")) as unknown as D1Database;
    await db.prepare("CREATE TABLE organizations (id TEXT PRIMARY KEY)").run();
    await db.prepare(USAGE_TABLE_0003).run();
    await applyMigration(db, "_api_requests.sql");
    await applyMigration(db, "_usage_cost_counters.sql");
  }, 60_000);

  afterAll(async () => {
    await mf.dispose();
  });

  it("creates the period row once, with every counter defaulting to 0", async () => {
    const o = await org();
    const first = (await getOrCreateUsage(db, "usg_first", o)) as UsageRow;
    const again = (await getOrCreateUsage(db, "usg_second", o)) as UsageRow;
    expect(first.id).toBe("usg_first");
    expect(again.id).toBe("usg_first");
    expect(first.messages_stored).toBe(0);
    expect(first.searches_run).toBe(0);
    expect(first.api_requests).toBe(0);
    expect(first.chunks_indexed).toBe(0);
  });

  it("reserves indexing up to the limit, then refuses and leaves the counter alone", async () => {
    const o = await org();
    await getOrCreateUsage(db, "usg_idx", o);

    expect(await atomicIncrementChunksIndexed(db, o, 1, 3)).toEqual({ chunks_indexed: 1 });
    expect(await atomicIncrementChunksIndexed(db, o, 1, 3)).toEqual({ chunks_indexed: 2 });
    expect(await atomicIncrementChunksIndexed(db, o, 1, 3)).toEqual({ chunks_indexed: 3 });
    expect(await atomicIncrementChunksIndexed(db, o, 1, 3)).toBeNull();
    expect(await atomicIncrementChunksIndexed(db, o, 1, 3)).toBeNull();

    const row = (await getUsage(db, o)) as UsageRow;
    expect(row.chunks_indexed).toBe(3);
  });

  it("refuses a whole batch that would cross the limit — never a partial reserve", async () => {
    const o = await org();
    await getOrCreateUsage(db, "usg_batch", o);

    expect(await atomicIncrementChunksIndexed(db, o, 2, 3)).toEqual({ chunks_indexed: 2 });
    // 2 + 2 > 3: nothing is counted for the refused batch…
    expect(await atomicIncrementChunksIndexed(db, o, 2, 3)).toBeNull();
    expect(((await getUsage(db, o)) as UsageRow).chunks_indexed).toBe(2);
    // …so a smaller batch that fits still can.
    expect(await atomicIncrementChunksIndexed(db, o, 1, 3)).toEqual({ chunks_indexed: 3 });
  });

  it("counts searches the same way", async () => {
    const o = await org();
    await getOrCreateUsage(db, "usg_srch", o);

    expect(await atomicIncrementSearches(db, o, 2)).toEqual({ searches_run: 1 });
    expect(await atomicIncrementSearches(db, o, 2)).toEqual({ searches_run: 2 });
    expect(await atomicIncrementSearches(db, o, 2)).toBeNull();
    expect(((await getUsage(db, o)) as UsageRow).searches_run).toBe(2);
  });

  it("the unguarded increment is unconditional (unlimited tiers)", async () => {
    const o = await org();
    await getOrCreateUsage(db, "usg_unl", o);
    await incrementChunksIndexed(db, o, 5);
    await incrementChunksIndexed(db, o, 5);
    expect(((await getUsage(db, o)) as UsageRow).chunks_indexed).toBe(10);
  });

  it("the shared counter helper did not change the message gate's behavior", async () => {
    const o = await org();
    await getOrCreateUsage(db, "usg_msg", o);
    expect(await atomicIncrementMessages(db, o, 1, 1)).toEqual({ messages_stored: 1 });
    expect(await atomicIncrementMessages(db, o, 1, 1)).toBeNull();
    expect(((await getUsage(db, o)) as UsageRow).messages_stored).toBe(1);
  });

  it("a release gives back exactly its own counter, clamped at zero (engram#591)", async () => {
    const o = await org();
    const period = "2030-05";
    await getOrCreateUsage(db, "usg_rel", o, period);
    await atomicIncrementMessages(db, o, 5, 100, period);
    await atomicIncrementChunksIndexed(db, o, 7, 100, period);

    await releaseMessagesStored(db, o, 2, period);
    await releaseChunksIndexed(db, o, 3, period);
    let row = (await db
      .prepare("SELECT * FROM usage WHERE organization_id = ? AND period = ?")
      .bind(o, period)
      .first()) as UsageRow;
    expect(row.messages_stored).toBe(3);
    expect(row.chunks_indexed).toBe(4);
    expect(row.searches_run).toBe(0);

    // Never below zero, whatever is released.
    await releaseMessagesStored(db, o, 50, period);
    await releaseChunksIndexed(db, o, 50, period);
    row = (await db
      .prepare("SELECT * FROM usage WHERE organization_id = ? AND period = ?")
      .bind(o, period)
      .first()) as UsageRow;
    expect(row.messages_stored).toBe(0);
    expect(row.chunks_indexed).toBe(0);
  });

  it("a charge and its release name one period, never the current one by default", async () => {
    const o = await org();
    await getOrCreateUsage(db, "usg_now", o);
    await atomicIncrementMessages(db, o, 4, 100);
    await getOrCreateUsage(db, "usg_old", o, "2020-01");
    expect(await atomicIncrementMessages(db, o, 6, 100, "2020-01")).toEqual({ messages_stored: 6 });
    expect(await atomicIncrementChunksIndexed(db, o, 2, 100, "2020-01")).toEqual({ chunks_indexed: 2 });

    await releaseMessagesStored(db, o, 6, "2020-01");
    await releaseChunksIndexed(db, o, 2, "2020-01");
    const old = (await db
      .prepare("SELECT * FROM usage WHERE organization_id = ? AND period = '2020-01'")
      .bind(o)
      .first()) as UsageRow;
    expect(old.messages_stored).toBe(0);
    expect(old.chunks_indexed).toBe(0);
    // The current period's row is untouched by either.
    expect(((await getUsage(db, o)) as UsageRow).messages_stored).toBe(4);
  });

  it("each counter moves independently of the others", async () => {
    const o = await org();
    await getOrCreateUsage(db, "usg_ind", o);
    await atomicIncrementChunksIndexed(db, o, 4, 100);
    await atomicIncrementSearches(db, o, 100);
    const row = (await getUsage(db, o)) as UsageRow;
    expect(row.chunks_indexed).toBe(4);
    expect(row.searches_run).toBe(1);
    expect(row.messages_stored).toBe(0);
  });
});
