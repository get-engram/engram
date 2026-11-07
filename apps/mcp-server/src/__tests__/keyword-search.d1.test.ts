import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import {
  FTS_MAX_RANKED_MATCHES,
  ftsMatch,
  ftsRowid,
  insertChunks,
  insertConversation,
  searchChunksFts,
} from "@getengram/db";
import { applyAllMigrations } from "./miniflare.js";

/**
 * engram#564, against real SQLite FTS5 (Miniflare). Keyword search builds its
 * MATCH from plain tokens, so queries FTS5 used to reject (quotes, colons,
 * parentheses, operators) now find what they name instead of quietly falling
 * back to semantic-only; every MATCH stays inside its organization; and a
 * query that matches more than the cap is declined before anything is
 * ranked.
 */

const ORG_A = "org_kw_a";
const ORG_B = "org_kw_b";
// Shares ORG_A's keyword-index token ("orgkwa"). The join on
// conversation_chunks.organization_id, not the token, keeps the two apart.
const ORG_A_TWIN = "org-kw-a";

const CHUNKS = [
  { id: "chk_a1", conv: "conv_a1", org: ORG_A, text: "[user]: how do I build C++ code with the foo:bar flag?\n[assistant]: run the kestrel build script, heron" },
  { id: "chk_a2", conv: "conv_a1", org: ORG_A, text: "[user]: the x-ray log at /var/log/app.log stopped at version 1.2.3\n[assistant]: rotate it, heron" },
  { id: "chk_a3", conv: "conv_a1", org: ORG_A, text: "[user]: the cabin is near alpha beta lake\n[assistant]: osprey and heron nest there" },
  { id: "chk_a4", conv: "conv_a2", org: ORG_A, text: "[user]: a kestrel hovered over the café\n[assistant]: osprey and falcons too" },
  { id: "chk_a5", conv: "conv_a2", org: ORG_A, text: "[user]: Antonia's notes about the osprey survey\n[assistant]: saved" },
  { id: "chk_b1", conv: "conv_b1", org: ORG_B, text: "[user]: kestrel secret for the other tenant, foo:bar C++ x-ray\n[assistant]: osprey" },
  { id: "chk_t1", conv: "conv_t1", org: ORG_A_TWIN, text: "[user]: kestrel twin secret\n[assistant]: osprey" },
] as const;

const IDS_OF = (org: string) => CHUNKS.filter((c) => c.org === org).map((c) => c.id);

describe("keyword search (engram#564), against real SQLite FTS5", () => {
  let mf: Miniflare;
  let db: D1Database;

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "keyword-search" },
    });
    db = await mf.getD1Database("DB");
    await applyAllMigrations(db);
    for (const org of [ORG_A, ORG_B, ORG_A_TWIN]) {
      await db.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)").bind(org, org).run();
    }
    for (const conv of new Set(CHUNKS.map((c) => `${c.conv}|${c.org}`))) {
      const [id, org] = conv.split("|");
      await insertConversation(db, id, org, id, null, [], {});
    }
    await insertChunks(
      db,
      CHUNKS.map((c, i) => ({
        id: c.id,
        conversationId: c.conv,
        organizationId: c.org,
        chunkText: c.text,
        chunkSummary: "",
        startSequence: i * 2 + 1,
        endSequence: i * 2 + 2,
        vectorizeId: `vec_${c.id}`,
      })),
    );
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  const ids = async (query: string, org = ORG_A, conversationId?: string) => {
    const r = await searchChunksFts(db, query, org, 50, conversationId);
    expect(r.skipped).toBeUndefined();
    return r.results.map((h) => h.chunk_id).sort();
  };

  it("finds what a malformed query names instead of failing", async () => {
    // Each of these was an FTS5 syntax error or an operator before, so keyword
    // search threw and the caller fell back to semantic-only.
    const cases: Array<[string, string[]]> = [
      ["C++ foo:bar", ["chk_a1"]],
      ['"kestrel', ["chk_a1", "chk_a4"]],
      ["kestrel)", ["chk_a1", "chk_a4"]],
      ["(kestrel", ["chk_a1", "chk_a4"]],
      ["kestrel*", ["chk_a1", "chk_a4"]],
      ["^kestrel", ["chk_a1", "chk_a4"]],
      ["kestrel:", ["chk_a1", "chk_a4"]],
      ["NEAR(alpha beta, 3)", ["chk_a3"]],
      ["x-ray", ["chk_a2"]],
      ["/var/log/app.log", ["chk_a2"]],
      ["version 1.2.3", ["chk_a2"]],
      ["Antonia's notes", ["chk_a5"]],
      ["CAFÉ", ["chk_a4"]],
      ["cafe", ["chk_a4"]],
      ["café", ["chk_a4"]],
    ];
    for (const [query, want] of cases) {
      expect(await ids(query), query).toEqual(want);
    }
  });

  it("treats operators as words: every term is required, none negated, no prefixes", async () => {
    // OR is a stopword and is dropped, so both words are required.
    expect(await ids("kestrel OR osprey")).toEqual(["chk_a4"]);
    // The minus is punctuation, not NOT.
    expect(await ids("+kestrel -falcons")).toEqual(["chk_a4"]);
    // A trailing * is not a prefix query: "kest" is a word nobody wrote.
    expect(await ids("kest*")).toEqual([]);
  });

  it("never returns another organization's chunks, whatever the query", async () => {
    const attempts = [
      "secret",
      "kestrel secret",
      'kestrel") OR (org:"orgkwb',
      'kestrel" OR org:"orgkwb" OR "kestrel',
      "org:orgkwb kestrel",
      "{org chunk_text}:kestrel",
      "chunk_text:secret",
      'secret OR org:"orgkwb"',
      "orgkwb",
      "org kw b secret",
    ];
    const allowed = new Set<string>(IDS_OF(ORG_A));
    // FTS rows of the token ORG_A shares with its twin. The org conjunct
    // must hold inside FTS5 itself, not only at the join.
    const tokenRows = new Set([...IDS_OF(ORG_A), ...IDS_OF(ORG_A_TWIN)].map(ftsRowid));
    for (const query of attempts) {
      const r = await searchChunksFts(db, query, ORG_A, 50);
      for (const h of r.results) expect(allowed.has(h.chunk_id), `${query} -> ${h.chunk_id}`).toBe(true);
      const match = ftsMatch(query, ORG_A);
      if (match === null) continue;
      const raw = await db.prepare("SELECT rowid FROM chunks_fts_v2 WHERE chunks_fts_v2 MATCH ?").bind(match).all<{ rowid: number }>();
      for (const row of raw.results ?? []) expect(tokenRows.has(row.rowid), `${query} -> rowid ${row.rowid}`).toBe(true);
    }
    // The same words find each tenant's own chunk.
    expect(await ids("secret")).toEqual([]);
    expect(await ids("secret", ORG_B)).toEqual(["chk_b1"]);
    expect(await ids("secret", ORG_A_TWIN)).toEqual(["chk_t1"]);
    expect(await ids("kestrel", ORG_A_TWIN)).toEqual(["chk_t1"]);
  });

  it("scopes to one conversation when asked", async () => {
    expect(await ids("kestrel", ORG_A, "conv_a2")).toEqual(["chk_a4"]);
    expect(await ids("osprey", ORG_A, "conv_a1")).toEqual(["chk_a3"]);
    // Another tenant's conversation id finds nothing.
    expect(await ids("kestrel", ORG_A, "conv_b1")).toEqual([]);
  });

  it("ranks up to the cap and declines one past it, without ranking", async () => {
    // "heron" is in three of ORG_A's chunks and nowhere else.
    const at = await searchChunksFts(db, "heron", ORG_A, 50, undefined, { maxMatches: 3 });
    expect(at.skipped).toBeUndefined();
    expect(at.results.map((h) => h.chunk_id).sort()).toEqual(["chk_a1", "chk_a2", "chk_a3"]);
    expect(await searchChunksFts(db, "heron", ORG_A, 50, undefined, { maxMatches: 2 })).toEqual({
      results: [],
      skipped: "too_broad",
    });
    // The conversation-scoped search is declined on the same org-wide count.
    expect(await searchChunksFts(db, "heron", ORG_A, 50, "conv_a1", { maxMatches: 2 })).toEqual({
      results: [],
      skipped: "too_broad",
    });
    // A word nobody wrote: no matches, nothing to decline.
    expect(await searchChunksFts(db, "plover", ORG_A, 50, undefined, { maxMatches: 1 })).toEqual({ results: [] });
  });

  it("counts by keyword-index token, so a shared token declines sooner, never later", async () => {
    // "osprey": three of ORG_A's chunks plus the twin's one under the same token.
    const four = await searchChunksFts(db, "osprey", ORG_A, 50, undefined, { maxMatches: 4 });
    expect(four.results.map((h) => h.chunk_id).sort()).toEqual(["chk_a3", "chk_a4", "chk_a5"]);
    expect((await searchChunksFts(db, "osprey", ORG_A, 50, undefined, { maxMatches: 3 })).skipped).toBe("too_broad");
    // ORG_B's token has only its own chunk.
    expect((await searchChunksFts(db, "osprey", ORG_B, 50, undefined, { maxMatches: 1 })).results.map((h) => h.chunk_id)).toEqual(["chk_b1"]);
  });

  it("runs every MATCH it can build without an FTS5 error (seeded)", async () => {
    // mulberry32: deterministic, so a failure here reproduces.
    let seed = 0x5641;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
    const words = [
      "kestrel", "osprey", "heron", "foo:bar", "C++", "x-ray", "near", "alpha", "beta", "café",
      "/var/log/app.log", "1.2.3", "the", "user", "assistant", "OR", "AND", "NOT", "NEAR", "org",
      "chunk_text", "orgkwb", "secret", "日本語", "Ünïcödé", "a", "",
    ];
    const marks = ['"', "(", ")", "*", "^", ":", "-", "+", "{", "}", "'", ",", "\\", "​", "́", "⃝", "", "🙂"];
    const queries: string[] = [];
    for (let i = 0; i < 400; i++) {
      let q = "";
      const n = 1 + Math.floor(rand() * 4);
      for (let j = 0; j < n; j++) {
        if (rand() < 0.5) q += pick(marks);
        q += pick(words);
        if (rand() < 0.3) q += pick(marks);
        q += rand() < 0.8 ? " " : "";
      }
      queries.push(q);
    }

    const built = queries
      .map((q) => ({ q, match: ftsMatch(q, ORG_A) }))
      .filter((x): x is { q: string; match: string } => x.match !== null);
    expect(built.length).toBeGreaterThan(300);

    // One batch: a single round trip for every probe and ranked statement.
    const stmts = built.flatMap(({ match }) => [
      db.prepare("SELECT rowid FROM chunks_fts_v2 WHERE chunks_fts_v2 MATCH ? LIMIT 50").bind(match),
      db
        .prepare(
          `SELECT c.id AS chunk_id, bm25(chunks_fts_v2, 1.0, 0.0) AS rank
             FROM chunks_fts_v2 f JOIN conversation_chunks c ON c.fts_rowid = f.rowid
            WHERE chunks_fts_v2 MATCH ? AND c.organization_id = ?
            ORDER BY bm25(chunks_fts_v2, 1.0, 0.0) LIMIT 50`,
        )
        .bind(match, ORG_A),
    ]);
    let out: D1Result[];
    try {
      out = await db.batch(stmts);
    } catch (err) {
      // Name the query that failed.
      for (const { q, match } of built) {
        try {
          await db.prepare("SELECT rowid FROM chunks_fts_v2 WHERE chunks_fts_v2 MATCH ?").bind(match).all();
        } catch (e) {
          throw new Error(`MATCH failed for ${JSON.stringify(q)} -> ${match}: ${String(e)}`);
        }
      }
      throw err;
    }

    const tokenRows = new Set([...IDS_OF(ORG_A), ...IDS_OF(ORG_A_TWIN)].map(ftsRowid));
    const allowed = new Set<string>(IDS_OF(ORG_A));
    let found = 0;
    for (let i = 0; i < built.length; i++) {
      const raw = (out[2 * i].results ?? []) as Array<{ rowid: number }>;
      const ranked = (out[2 * i + 1].results ?? []) as Array<{ chunk_id: string }>;
      for (const row of raw) expect(tokenRows.has(row.rowid), built[i].q).toBe(true);
      for (const h of ranked) expect(allowed.has(h.chunk_id), built[i].q).toBe(true);
      if (ranked.length > 0) found++;
    }
    // Not vacuous: plenty of the generated queries find something.
    expect(found).toBeGreaterThan(80);
  });
});

describe("searchChunksFts without a database", () => {
  /** A D1 stand-in that records what is bound and answers the probe with `n`. */
  function recording(n: number | null) {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            calls.push({ sql, args });
            return {
              first: async () => (n === null ? null : { n }),
              all: async () => ({ results: [{ chunk_id: "chk_x", rank: -1 }] }),
            };
          },
        };
      },
    } as unknown as D1Database;
    return { db, calls };
  }

  it("sends nothing to D1 when the query has no searchable words", async () => {
    const db = {
      prepare() {
        throw new Error("no D1 call expected");
      },
    } as unknown as D1Database;
    for (const q of ["", "   ", "the of and", "a", '""', "()", "* ^ : - +", "user assistant", '"the user"', "OR AND NOT"]) {
      expect(await searchChunksFts(db, q, ORG_A, 10), JSON.stringify(q)).toEqual({ results: [], skipped: "no_terms" });
    }
  });

  it("binds LIMIT cap + 1 on the probe; maxMatches can lower the cap, never raise it", async () => {
    const limitFor = async (opts?: { maxMatches?: number }) => {
      const { db, calls } = recording(0);
      await searchChunksFts(db, "kestrel", ORG_A, 10, undefined, opts);
      expect(calls).toHaveLength(1);
      expect(calls[0].sql).toMatch(/^SELECT count\(\*\) AS n FROM \(SELECT rowid FROM chunks_fts_v2 WHERE chunks_fts_v2 MATCH \? LIMIT \?\)$/);
      return calls[0].args[1];
    };
    const dflt = FTS_MAX_RANKED_MATCHES + 1;
    expect(await limitFor()).toBe(dflt);
    expect(await limitFor({ maxMatches: 5 })).toBe(6);
    expect(await limitFor({ maxMatches: FTS_MAX_RANKED_MATCHES - 1 })).toBe(FTS_MAX_RANKED_MATCHES);
    expect(await limitFor({ maxMatches: FTS_MAX_RANKED_MATCHES })).toBe(dflt);
    for (const bad of [FTS_MAX_RANKED_MATCHES + 1, 1e9, 0, -3, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await limitFor({ maxMatches: bad }), String(bad)).toBe(dflt);
    }
  });

  it("ranks only when the probe finds between 1 and cap matches", async () => {
    const run = async (n: number) => {
      const { db, calls } = recording(n);
      const r = await searchChunksFts(db, "kestrel", ORG_A, 10, undefined, { maxMatches: 5 });
      return { r, ranked: calls.length - 1 };
    };
    expect(await run(0)).toEqual({ r: { results: [] }, ranked: 0 });
    expect(await run(1)).toEqual({ r: { results: [{ chunk_id: "chk_x", rank: -1 }] }, ranked: 1 });
    expect(await run(5)).toEqual({ r: { results: [{ chunk_id: "chk_x", rank: -1 }] }, ranked: 1 });
    expect(await run(6)).toEqual({ r: { results: [], skipped: "too_broad" }, ranked: 0 });
  });

  it("binds the org conjunct's MATCH and the organization id on the ranked query", async () => {
    for (const conv of [undefined, "conv_a2"]) {
      const { db, calls } = recording(1);
      await searchChunksFts(db, "kestrel", ORG_A, 10, conv);
      const match = ftsMatch("kestrel", ORG_A);
      expect(calls[0].args[0]).toBe(match);
      expect(calls[1].args[0]).toBe(match);
      expect(calls[1].sql).toContain("JOIN conversation_chunks c ON c.fts_rowid = f.rowid");
      expect(calls[1].sql).toContain("AND c.organization_id = ?");
      expect(calls[1].args[1]).toBe(ORG_A);
      if (conv) expect(calls[1].args.slice(2)).toEqual([conv, 10]);
      else expect(calls[1].args.slice(2)).toEqual([10]);
    }
  });

  it("throws when the probe returns no row, so the caller logs a failure", async () => {
    const { db } = recording(null);
    await expect(searchChunksFts(db, "kestrel", ORG_A, 10)).rejects.toThrow("keyword probe returned no row");
  });
});
