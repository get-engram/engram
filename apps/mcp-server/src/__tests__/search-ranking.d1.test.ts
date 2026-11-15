import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
  WEAK_PAGE_NOTICE,
} from "../services/search.js";
import { CHUNK_R2_ENCODING, chunkObjectKey } from "../services/chunk-store.js";
import { RERANK_MODEL } from "../services/relevance-check.js";
import { registerSearch } from "../mcp/tools/search.js";
import { Hono } from "hono";
import { v1 } from "../routes/v1.js";
import type { AuthContext, Env } from "../types.js";

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
  /** What the relevance model answers. Down by default: the ranking tests
   *  below then see pages without labels, as when the check fails. */
  type RerankInput = { query: string; contexts: { text: string }[]; top_k: number };
  const rerankDown = (): unknown => {
    throw new Error("reranker down");
  };
  let rerank: (input: RerankInput) => unknown = rerankDown;
  let rerankInputs: RerankInput[] = [];
  /** Score each text by the first rule whose words it contains, else 0.0004. */
  const rerankBy =
    (rules: [string, number][]) =>
    (input: RerankInput): unknown => ({
      response: input.contexts.map((c, id) => ({
        id,
        score: rules.find(([needle]) => c.text.includes(needle))?.[1] ?? 0.0004,
      })),
    });

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
    mocks.AI.run = async (model: string, input: { text: string[] } & RerankInput) => {
      if (model === RERANK_MODEL) {
        rerankInputs.push(input);
        return rerank(input);
      }
      return { data: input.text.map(() => new Array(768).fill(0.1)) };
    };
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

  afterEach(() => {
    rerank = rerankDown;
    rerankInputs = [];
    delete (env as unknown as { SEARCH_RELEVANCE_CHECK?: string }).SEARCH_RELEVANCE_CHECK;
    vi.restoreAllMocks();
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
  // The relevance check (engram#758, stage 2).

  it("labels what the second model calls unrelated as weak, and an answer as strong", async () => {
    matches = [
      { id: "chk_conv_old_best", score: 0.8 },
      { id: "chk_conv_third", score: 0.79 },
    ];
    rerank = rerankBy([["the old, best answer", 0.93]]);
    const results = await search("nothing in common with either");
    expect(results.map((r) => [r.conversation_id, r.match])).toEqual([
      ["conv_old_best", "strong"],
      ["conv_third", "weak"],
    ]);
    // Labelled, not dropped, and in the order ranking chose.
    expect(results).toHaveLength(2);
  });

  it("does not call a result weak at the threshold, only under it", async () => {
    matches = [
      { id: "chk_conv_old_best", score: 0.8 },
      { id: "chk_conv_third", score: 0.79 },
    ];
    rerank = rerankBy([
      ["the old, best answer", 0.02],
      ["something else again", 0.0199],
    ]);
    const results = await search("nothing in common with either");
    expect(results.map((r) => r.match)).toEqual(["strong", "weak"]);
  });

  it("never calls a keyword match or a title match weak, whatever the model says", async () => {
    matches = [
      { id: "chk_conv_old_best", score: 0.8 },
      { id: "chk_conv_third", score: 0.79 },
    ];
    rerank = rerankBy([]);
    // "zzdelta" is a word of conv_third's text.
    const byKeyword = await search("zzdelta");
    expect(byKeyword.find((r) => r.conversation_id === "conv_third")?.match).toBe("strong");
    expect(byKeyword.find((r) => r.conversation_id === "conv_old_best")?.match).toBe("weak");
    // "Kitchen" is conv_old_best's title.
    const byTitle = await search("kitchen");
    expect(byTitle.find((r) => r.conversation_id === "conv_old_best")?.match).toBe("strong");
    expect(byTitle.find((r) => r.conversation_id === "conv_third")?.match).toBe("weak");
  });

  it("returns the page unlabelled when the model fails or answers nonsense", async () => {
    matches = [
      { id: "chk_conv_old_best", score: 0.8 },
      { id: "chk_conv_third", score: 0.79 },
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const broken of [rerankDown, () => ({}), () => ({ data: [[0.1]] }), () => null]) {
      rerank = broken;
      const results = await search("nothing in common with either");
      expect(results.map((r) => r.conversation_id)).toEqual(["conv_old_best", "conv_third"]);
      expect(results.every((r) => r.match === undefined)).toBe(true);
    }
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      '[search] relevance check skipped {"reason":"error"}',
      '[search] relevance check skipped {"reason":"shape"}',
      '[search] relevance check skipped {"reason":"shape"}',
      '[search] relevance check skipped {"reason":"shape"}',
    ]);
  });

  it("reads the whole text, from the bucket too, and leaves a result it cannot read unlabelled", async () => {
    matches = [
      { id: "chk_conv_lost", score: 0.8 },
      { id: "chk_conv_twin_b", score: 0.79 },
    ];
    rerank = rerankBy([]);
    const results = await searchConversations(env as unknown as SearchEnv, ORG, "nothing in common", 5, undefined, undefined, 10);
    expect(rerankInputs).toHaveLength(1);
    // conv_twin_b's text lives only in the bucket; the caller asked for a
    // 10-character snippet; the model still gets all of it. conv_lost's text
    // cannot be read, so it is not sent.
    expect(rerankInputs[0].contexts).toEqual([{ text: "[user]: zzgamma three\n[assistant]: the very same words" }]);
    expect(rerankInputs[0].query).toBe("nothing in common");
    expect(results.find((r) => r.conversation_id === "conv_twin_b")?.match).toBe("weak");
    expect(results.find((r) => r.conversation_id === "conv_lost")?.match).toBeUndefined();
  });

  it("does not run inside one conversation, or when switched off, or for an empty page", async () => {
    matches = [{ id: "chk_conv_old_best", score: 0.8 }];
    rerank = rerankBy([]);
    const scoped = await searchConversations(env as unknown as SearchEnv, ORG, "nothing in common", 5, "conv_old_best");
    expect(scoped).toHaveLength(1);
    expect(scoped[0].match).toBeUndefined();

    (env as unknown as { SEARCH_RELEVANCE_CHECK?: string }).SEARCH_RELEVANCE_CHECK = "off";
    const off = await search("nothing in common");
    expect(off).toHaveLength(1);
    expect(off[0].match).toBeUndefined();
    delete (env as unknown as { SEARCH_RELEVANCE_CHECK?: string }).SEARCH_RELEVANCE_CHECK;

    matches = [];
    expect(await search("qqnothing")).toEqual([]);
    expect(rerankInputs).toEqual([]);
  });

  it("logs counts, never the query or the text", async () => {
    matches = [
      { id: "chk_conv_old_best", score: 0.8 },
      { id: "chk_conv_third", score: 0.79 },
    ];
    rerank = rerankBy([["the old, best answer", 0.93]]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await search("a very private question");
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("relevance check"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[search\] relevance check \{"results":2,"checked":2,"weak":1,"ms":\d+\}$/);
    const everything = [...log.mock.calls, ...[]].flat().join(" ");
    expect(everything).not.toContain("private question");
    expect(everything).not.toContain("best answer");
  });

  it("tells the caller of the search tool when nothing strong matched, and only then", async () => {
    const handlers = new Map<string, (params: Record<string, unknown>) => Promise<{ content: { text: string }[] }>>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: (params: Record<string, unknown>) => Promise<{ content: { text: string }[] }>) => {
        handlers.set(name, handler);
      },
    } as unknown as McpServer;
    registerSearch(server, env as unknown as SearchEnv, {
      organizationId: ORG,
      apiKeyId: "key_test",
      tier: "enterprise",
      scopes: ["read", "write", "search", "delete"],
    });
    const call = async (query: string) =>
      JSON.parse((await handlers.get("search")!({ query, limit: 5 })).content[0].text) as {
        results: { conversation_id: string; match?: string }[];
        notice?: string;
      };
    matches = [
      { id: "chk_conv_old_best", score: 0.8 },
      { id: "chk_conv_third", score: 0.79 },
    ];

    rerank = rerankBy([]);
    const nothing = await call("nothing in common with either");
    expect(nothing.results.map((r) => r.match)).toEqual(["weak", "weak"]);
    expect(nothing.notice).toBe(WEAK_PAGE_NOTICE);

    rerank = rerankBy([["the old, best answer", 0.93]]);
    const something = await call("nothing in common with either");
    expect(something.results.map((r) => r.match)).toEqual(["strong", "weak"]);
    expect(something.notice).toBeUndefined();

    // The check failed: no labels, so no claim either way.
    rerank = rerankDown;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const unknown = await call("nothing in common with either");
    expect(unknown.results).toHaveLength(2);
    expect(unknown.notice).toBeUndefined();
  });
  it("tells the caller of the REST search the same thing", async () => {
    const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
    app.use("*", async (c, next) => {
      c.set("auth", {
        organizationId: ORG,
        apiKeyId: "key_test",
        tier: "enterprise",
        scopes: ["read", "write", "search", "delete"],
      });
      await next();
    });
    app.route("/api/v1", v1);
    const call = async () => {
      const res = await app.request("/api/v1/search?q=nothing+in+common+with+either", { method: "GET" }, env as unknown as Env);
      expect(res.status).toBe(200);
      return (await res.json()) as { results: { match?: string }[]; total: number; notice?: string };
    };
    matches = [
      { id: "chk_conv_old_best", score: 0.8 },
      { id: "chk_conv_third", score: 0.79 },
    ];

    rerank = rerankBy([]);
    const nothing = await call();
    expect(nothing.total).toBe(2);
    expect(nothing.results.map((r) => r.match)).toEqual(["weak", "weak"]);
    expect(nothing.notice).toBe(WEAK_PAGE_NOTICE);

    rerank = rerankBy([["the old, best answer", 0.93]]);
    const something = await call();
    expect(something.results.map((r) => r.match)).toEqual(["strong", "weak"]);
    expect(something.notice).toBeUndefined();
  });
});
