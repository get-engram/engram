import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import { insertChunks, insertConversation } from "@getengram/db";
import { summarizeChunk } from "@getengram/shared";
import { applyAllMigrations } from "./miniflare.js";
import { createMockEnv } from "./helpers.js";
import {
  candidatePoolSize,
  recencyMultiplier,
  searchConversations,
  semanticContribution,
  titleMultiplier,
  titleTerms,
} from "../services/search.js";
import { CHUNK_R2_ENCODING, chunkObjectKey } from "../services/chunk-store.js";

/**
 * How search ranks (engram#758). The numbers are tuned on the relevance
 * benchmark (search-relevance.d1.test.ts); these tests pin the rules.
 */

describe("ranking helpers (engram#758)", () => {
  it("recency adds at most 8% and fades with age", () => {
    const now = recencyMultiplier(new Date().toISOString());
    const month = recencyMultiplier(new Date(Date.now() - 30 * 86_400_000).toISOString());
    const year = recencyMultiplier(new Date(Date.now() - 365 * 86_400_000).toISOString());
    expect(now).toBeGreaterThan(month);
    expect(month).toBeGreaterThan(year);
    expect(now).toBeLessThanOrEqual(1.08);
    expect(month).toBeCloseTo(1.04, 3);
    expect(year).toBeGreaterThanOrEqual(1);
    expect(year).toBeLessThan(1.001);
  });

  it("matches titles on the query's meaningful words only", () => {
    expect(titleTerms("email to Antonia")).toEqual(["email", "antonia"]);
    expect(titleTerms("what did we decide about the report")).toEqual(["decide", "report"]);
    expect(titleTerms("goals for 2026")).toEqual(["goals"]);
    expect(titleTerms("the and for")).toEqual([]);
  });

  it("boosts a title on whole words, by the share of the query it has", () => {
    expect(titleMultiplier("Email to Antonia", ["email", "antonia"])).toBeCloseTo(1.2, 6);
    expect(titleMultiplier("Email cleanup", ["email", "antonia"])).toBeCloseTo(1.1, 6);
    // "port" is inside "Report" but is not a word of it.
    expect(titleMultiplier("Weekly Report", ["port"])).toBe(1);
    expect(titleMultiplier("Port 8787 in use", ["port"])).toBeCloseTo(1.2, 6);
    expect(titleMultiplier("Anything", [])).toBe(1);
    expect(titleMultiplier(null, ["email"])).toBe(1);
  });

  it("scores a semantic hit by its similarity to the best one", () => {
    const best = semanticContribution(0.8, 0.8, 0);
    expect(best).toBeCloseTo(1 / 60, 9);
    const nearTie = semanticContribution(0.79, 0.8, 1);
    const farBehind = semanticContribution(0.6, 0.8, 1);
    expect(nearTie / best).toBeGreaterThan(0.96);
    expect(farBehind / best).toBeLessThan(0.5);
    // Never more than the best hit, never negative.
    expect(semanticContribution(0.9, 0.8, 3)).toBeCloseTo(1 / 60, 9);
    expect(semanticContribution(-0.2, 0.8, 3)).toBe(0);
    // No usable similarity: fall back to rank.
    expect(semanticContribution(0, 0, 2)).toBeCloseTo(1 / 62, 9);
    expect(semanticContribution(Number.NaN, 0.8, 2)).toBeCloseTo(1 / 62, 9);
  });

  it("takes a wider candidate pool when a filter will discard most of it", () => {
    expect(candidatePoolSize(5, false)).toBe(15);
    expect(candidatePoolSize(5, true)).toBe(30);
    expect(candidatePoolSize(20, false)).toBe(50);
    expect(candidatePoolSize(20, true)).toBe(50);
  });
});

describe("ranking, end to end (engram#758)", () => {
  const ORG = "org_ranking";
  type SearchEnv = Parameters<typeof searchConversations>[0];
  let mf: Miniflare;
  let db: D1Database;
  let env: ReturnType<typeof createMockEnv>;
  /** What the vector index answers for the next search. */
  let matches: { id: string; score: number }[] = [];
  let lastTopK = 0;

  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

  async function addConversation(
    id: string,
    title: string,
    ageDays: number,
    text: string,
    opts: { tags?: string[]; inBucket?: boolean; unreadable?: boolean } = {},
  ): Promise<string> {
    await insertConversation(db, id, ORG, title, "test", opts.tags ?? [], {});
    await db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").bind(daysAgo(ageDays), id).run();
    const chunkId = `chk_${id}`;
    await insertChunks(db, [
      {
        id: chunkId,
        conversationId: id,
        organizationId: ORG,
        chunkText: text,
        chunkSummary: summarizeChunk(text),
        startSequence: 1,
        endSequence: 2,
        vectorizeId: chunkId,
      },
    ]);
    if (opts.inBucket || opts.unreadable) {
      if (!opts.unreadable) await env.CHUNKS.put(chunkObjectKey(id, chunkId), text);
      await db
        .prepare("UPDATE conversation_chunks SET chunk_text = '', chunk_encoding = ? WHERE id = ?")
        .bind(CHUNK_R2_ENCODING, chunkId)
        .run();
    }
    return chunkId;
  }

  const search = (query: string, limit = 5, extra: { tags?: string[]; dedupe?: boolean; seat?: string } = {}) =>
    searchConversations(
      env as unknown as SearchEnv,
      ORG,
      query,
      limit,
      undefined,
      extra.tags,
      undefined,
      undefined,
      extra.dedupe ?? true,
      undefined,
      extra.seat,
    );

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "search-ranking" },
    });
    db = await mf.getD1Database("DB");
    await applyAllMigrations(db);
    await db.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)").bind(ORG, "ranking").run();
    env = createMockEnv(db);
    const mocks = env as unknown as { AI: { run: unknown }; VECTORIZE: { query: unknown } };
    mocks.AI.run = async (_model: string, input: { text: string[] }) => ({
      data: input.text.map(() => new Array(768).fill(0.1)),
    });
    mocks.VECTORIZE.query = async (_vector: number[], opts: { topK: number }) => {
      lastTopK = opts.topK;
      return { count: matches.length, matches: matches.slice(0, opts.topK) };
    };

    await addConversation("conv_old_best", "Kitchen", 300, "[user]: zzalpha one\n[assistant]: the old, best answer");
    await addConversation("conv_new_weak", "Garden", 0, "[user]: zzbeta two\n[assistant]: the new, weaker answer");
    await addConversation("conv_twin_a", "Twin", 40, "[user]: zzgamma three\n[assistant]: the very same words");
    await addConversation("conv_twin_b", "Twin", 2, "[user]: zzgamma three\n[assistant]: the very same words", {
      inBucket: true,
    });
    await addConversation("conv_third", "Shed", 100, "[user]: zzdelta four\n[assistant]: something else again");
    await addConversation("conv_lost", "Attic", 100, "[user]: zzepsilon five\n[assistant]: text nobody can read", {
      unreadable: true,
    });
    await addConversation("conv_private", "Vault", 1, "[user]: zzzeta six\n[assistant]: another seat's secret");
    await db
      .prepare("UPDATE conversations SET visibility = 'private', seat_id = ? WHERE id = ?")
      .bind("seat_other", "conv_private")
      .run();
  }, 120_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  it("does not let a recent conversation outrank a clearly better match in an old one", async () => {
    matches = [
      { id: "chk_conv_old_best", score: 0.8 },
      { id: "chk_conv_new_weak", score: 0.72 },
    ];
    const results = await search("qqnomatch");
    expect(results.map((r) => r.conversation_id)).toEqual(["conv_old_best", "conv_new_weak"]);
  });

  it("lets recency settle a near-tie", async () => {
    matches = [
      { id: "chk_conv_old_best", score: 0.8 },
      { id: "chk_conv_new_weak", score: 0.795 },
    ];
    const results = await search("qqnomatch");
    expect(results.map((r) => r.conversation_id)).toEqual(["conv_new_weak", "conv_old_best"]);
  });

  it("drops a semantic-only hit that is far behind the best one", async () => {
    matches = [
      { id: "chk_conv_old_best", score: 0.8 },
      { id: "chk_conv_third", score: 0.5 },
    ];
    const results = await search("qqnomatch");
    expect(results.map((r) => r.conversation_id)).toEqual(["conv_old_best"]);
  });

  it("keeps far-behind hits when the search is scoped to one conversation", async () => {
    await insertChunks(db, [
      {
        id: "chk_conv_third_2",
        conversationId: "conv_third",
        organizationId: ORG,
        chunkText: "[user]: zzdelta later\n[assistant]: further down the same conversation",
        chunkSummary: "further down",
        startSequence: 3,
        endSequence: 4,
        vectorizeId: "chk_conv_third_2",
      },
    ]);
    matches = [
      { id: "chk_conv_third", score: 0.8 },
      { id: "chk_conv_third_2", score: 0.5 },
    ];
    const scoped = await searchConversations(env as unknown as SearchEnv, ORG, "qqnomatch", 5, "conv_third");
    expect(scoped.map((r) => r.chunk_id)).toEqual(["chk_conv_third", "chk_conv_third_2"]);
  });

  it("returns word-for-word repeats once, and fills the place from the next candidate", async () => {
    matches = [
      { id: "chk_conv_twin_a", score: 0.8 },
      { id: "chk_conv_twin_b", score: 0.8 },
      { id: "chk_conv_third", score: 0.78 },
    ];
    const results = await search("qqnomatch", 2);
    // The newer copy wins the tie; its text came from the bucket.
    expect(results.map((r) => r.conversation_id)).toEqual(["conv_twin_b", "conv_third"]);
    expect(results[0].chunk_text).toContain("the very same words");

    const all = await search("qqnomatch", 3, { dedupe: false });
    expect(all.map((r) => r.conversation_id).sort()).toEqual(["conv_third", "conv_twin_a", "conv_twin_b"]);
  });

  it("keeps a result whose text cannot be read, with its summary", async () => {
    matches = [
      { id: "chk_conv_lost", score: 0.8 },
      { id: "chk_conv_third", score: 0.79 },
    ];
    const results = await search("qqnomatch");
    expect(results.map((r) => r.conversation_id).sort()).toEqual(["conv_lost", "conv_third"]);
    const lost = results.find((r) => r.conversation_id === "conv_lost")!;
    expect(lost.chunk_text).toBe(lost.chunk_summary);
  });

  it("scores against the best hit the caller can see, not a hidden one", async () => {
    matches = [
      { id: "chk_conv_old_best", score: 0.6 },
      { id: "chk_conv_third", score: 0.58 },
    ];
    const without = await search("qqnomatch");
    matches = [{ id: "chk_conv_private", score: 0.95 }, ...matches];
    const withHidden = await search("qqnomatch");
    expect(withHidden.map((r) => r.conversation_id)).not.toContain("conv_private");
    expect(withHidden.map((r) => r.conversation_id)).toEqual(without.map((r) => r.conversation_id));
    // Equal but for the clock moving between the two searches.
    withHidden.forEach((r, i) => expect(r.score).toBeCloseTo(without[i].score, 6));
    // The seat that owns it does see it.
    const owner = await search("qqnomatch", 5, { seat: "seat_other" });
    expect(owner[0].conversation_id).toBe("conv_private");
  });

  it("asks both lists for more when a tag filter is set", async () => {
    matches = [{ id: "chk_conv_old_best", score: 0.8 }];
    await search("qqnomatch", 5);
    expect(lastTopK).toBe(15);
    await search("qqnomatch", 5, { tags: ["anything"] });
    expect(lastTopK).toBe(30);
  });

  it("looks up a hundred conversations without passing D1's bound-value limit", async () => {
    const semantic: { id: string; score: number }[] = [];
    for (let i = 0; i < 50; i++) {
      semantic.push({
        id: await addConversation(`conv_sem_${i}`, `Sem ${i}`, 200, `[user]: semantic filler ${i}`),
        score: 0.8 - i * 0.0001,
      });
    }
    for (let i = 0; i < 50; i++) {
      await addConversation(`conv_kw_${i}`, `Kw ${i}`, 200, `[user]: zzbulkword filler ${i}`);
    }
    matches = semantic;

    let mostBound = 0;
    let conversationLookups = 0;
    const counting = new Proxy(db, {
      get(target, prop) {
        if (prop !== "prepare") {
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string) => {
          const stmt = target.prepare(sql);
          return new Proxy(stmt, {
            get(s, p) {
              const value = Reflect.get(s, p);
              if (p !== "bind") return typeof value === "function" ? value.bind(s) : value;
              return (...values: unknown[]) => {
                mostBound = Math.max(mostBound, values.length);
                if (/FROM conversations WHERE id IN/.test(sql)) conversationLookups++;
                return s.bind(...values);
              };
            },
          });
        };
      },
    });
    const real = env.DB;
    (env as unknown as { DB: D1Database }).DB = counting;
    try {
      const results = await search("zzbulkword", 20);
      expect(results).toHaveLength(20);
      expect(conversationLookups).toBe(2);
      expect(mostBound).toBeLessThanOrEqual(100);
      // Both lists made it onto the page.
      expect(results.some((r) => r.conversation_id.startsWith("conv_sem_"))).toBe(true);
      expect(results.some((r) => r.conversation_id.startsWith("conv_kw_"))).toBe(true);
    } finally {
      (env as unknown as { DB: D1Database }).DB = real;
    }
  });
});
