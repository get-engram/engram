import { describe, it, expect, vi } from "vitest";
import { getChunksByIds } from "@getengram/db";
import { searchConversations } from "../services/search.js";
import { createMockD1, createMockEnv } from "./helpers.js";
import type { Env } from "../types.js";

/**
 * Search hydration is fenced to the caller's organization at two layers
 * (engram#452).
 *
 * 1. In SQL: both chunk hydration queries carry `organization_id = ?`, so a
 *    chunk id or vector id that belongs to another tenant is never read.
 * 2. In the result loop: a chunk whose conversation does not resolve inside
 *    the org — an orphan of a deleted conversation, or anything a leaky
 *    hydration might hand back — is dropped rather than emitted untitled.
 *
 * The mock D1 only fences the `id IN (…)` query, not the `vectorize_id IN`
 * one, which makes it a convenient stand-in for "hydration leaked": the
 * second layer has to catch what the first did not.
 */

describe("getChunksByIds", () => {
  it("fences by organization in SQL and forces the primary-key index", () => {
    let sql = "";
    let bound: unknown[] = [];
    const db = {
      prepare: (q: string) => {
        sql = q;
        return {
          bind: (...b: unknown[]) => {
            bound = b;
            return { all: async () => ({ results: [] }) };
          },
        };
      },
    } as unknown as D1Database;
    void getChunksByIds(db, ["chk_a", "chk_b"], "org_x");
    // Without INDEXED BY the planner picks idx_chunks_org for this shape and
    // walks the whole org before filtering by id (verified against prod,
    // 2026-11-02) — the #469 regression in a new coat.
    expect(sql).toMatch(
      /FROM conversation_chunks INDEXED BY sqlite_autoindex_conversation_chunks_1 WHERE id IN \(\?,\?\) AND organization_id = \?$/,
    );
    expect(bound).toEqual(["chk_a", "chk_b", "org_x"]);
  });
});

describe("search result fence", () => {
  const MINE = "the owner's secret recipe";
  const THEIRS = "another tenant's secret recipe";
  const ORPHAN = "secret recipe from a deleted conversation";

  function seeded() {
    const db = createMockD1();
    const conv = (id: string, org: string, title: string) =>
      db
        .prepare("INSERT INTO conversations (id, organization_id, title, tags, updated_at) VALUES (?,?,?,?,?)")
        .bind(id, org, title, "[]", "2026-11-01")
        .run();
    const chunk = (id: string, conv: string, org: string, text: string, vec: string) =>
      db
        .prepare(
          "INSERT INTO conversation_chunks (id, conversation_id, organization_id, chunk_text, start_sequence, end_sequence, vectorize_id, created_at) VALUES (?,?,?,?,?,?,?,?)",
        )
        .bind(id, conv, org, text, 1, 2, vec, "2026-11-01")
        .run();
    conv("conv_mine", "org_a", "Mine");
    conv("conv_theirs", "org_b", "Theirs");
    // conv_gone has no row: its chunk is an orphan.
    chunk("chk_mine", "conv_mine", "org_a", MINE, "vec_mine");
    chunk("chk_theirs", "conv_theirs", "org_b", THEIRS, "vec_theirs");
    chunk("chk_orphan", "conv_gone", "org_a", ORPHAN, "vec_orphan");

    // Make FTS "find" all three, as if the FTS index were not org-scoped,
    // and record every hydration statement.
    const prepared: { sql: string; bindings: unknown[] }[] = [];
    const real = db.prepare.bind(db);
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      if (sql.includes("chunks_fts")) {
        return {
          bind: (...b: unknown[]) => {
            prepared.push({ sql, bindings: b });
            return {
              // The probe (engram#564): three matches, under the cap.
              first: async () => ({ n: 3 }),
              all: async () => ({
                results: [
                  { chunk_id: "chk_theirs", rank: -3 },
                  { chunk_id: "chk_orphan", rank: -2 },
                  { chunk_id: "chk_mine", rank: -1 },
                ],
                success: true,
                meta: {},
              }),
            };
          },
        };
      }
      const stmt = real(sql);
      const bind = stmt.bind.bind(stmt);
      stmt.bind = (...b: unknown[]) => {
        prepared.push({ sql, bindings: b });
        return bind(...b);
      };
      return stmt;
    };

    const env = createMockEnv(db);
    // Vector search "matches" all three too.
    (env.VECTORIZE as unknown as Record<string, unknown>).query = vi.fn(async () => ({
      count: 3,
      matches: [
        { id: "vec_theirs", score: 0.99 },
        { id: "vec_orphan", score: 0.98 },
        { id: "vec_mine", score: 0.97 },
      ],
    }));
    return { env: env as unknown as Env, prepared };
  }

  it("emits only chunks whose conversation resolves inside the caller's org", async () => {
    const { env, prepared } = seeded();
    const results = await searchConversations(env, "org_a", "secret recipe", 10, undefined, undefined, undefined, 0, true);

    expect(results.map((r) => r.chunk_id)).toEqual(["chk_mine"]);
    const text = JSON.stringify(results);
    expect(text).toContain(MINE);
    expect(text).not.toContain(THEIRS);
    expect(text).not.toContain(ORPHAN);

    // Both hydration statements were fenced to org_a in SQL.
    const byId = prepared.find((p) => p.sql.includes("WHERE id IN (") && p.sql.includes("conversation_chunks"));
    const byVec = prepared.find((p) => p.sql.includes("vectorize_id IN ("));
    expect(byId?.sql).toContain("INDEXED BY sqlite_autoindex_conversation_chunks_1");
    expect(byId?.sql).toMatch(/AND organization_id = \?$/);
    expect(byId?.bindings.at(-1)).toBe("org_a");
    expect(byVec?.sql).toMatch(/AND organization_id = \?$/);
    expect(byVec?.bindings.at(-1)).toBe("org_a");
  });
});
