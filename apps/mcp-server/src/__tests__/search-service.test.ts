import { describe, it, expect, beforeAll, vi } from "vitest";
import { createMockD1, createMockEnv } from "./helpers.js";
import {
  searchConversations,
  recencyMultiplier,
  queryTerms,
} from "../services/search.js";

describe("search recall helpers (#215)", () => {
  it("recencyMultiplier is 1.0 for missing/invalid timestamps", () => {
    expect(recencyMultiplier()).toBe(1);
    expect(recencyMultiplier(null)).toBe(1);
    expect(recencyMultiplier("not-a-date")).toBe(1);
  });

  it("recencyMultiplier boosts recent conversations more than old ones", () => {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 365 * 86_400_000).toISOString();
    const recent = recencyMultiplier(now);
    const stale = recencyMultiplier(old);
    expect(recent).toBeGreaterThan(stale);
    expect(recent).toBeGreaterThan(1);
    expect(recent).toBeLessThanOrEqual(1.5);
    expect(stale).toBeGreaterThanOrEqual(1);
  });

  it("queryTerms extracts distinct lowercased terms >= 3 chars", () => {
    expect(queryTerms("email to Antonia")).toEqual(["email", "antonia"]);
    expect(queryTerms("a to Antonia Antonia")).toEqual(["antonia"]);
  });
});

describe("search service", () => {
  const organizationId = "org_search";
  let db: D1Database;
  let env: ReturnType<typeof createMockEnv>;

  beforeAll(() => {
    db = createMockD1();

    // Seed two chunks: one short, one very long.
    const longText = "a".repeat(6000);
    db.prepare(
      "INSERT INTO conversation_chunks (id, conversation_id, organization_id, chunk_text, start_sequence, end_sequence, vectorize_id, created_at) VALUES (?,?,?,?,?,?,?,?)"
    )
      .bind(
        "chk_short",
        "conv_1",
        organizationId,
        "[user]: hi\n[assistant]: hello",
        1,
        2,
        "vec_short",
        "2026-04-11"
      )
      .run();
    db.prepare(
      "INSERT INTO conversation_chunks (id, conversation_id, organization_id, chunk_text, start_sequence, end_sequence, vectorize_id, created_at) VALUES (?,?,?,?,?,?,?,?)"
    )
      .bind(
        "chk_long",
        "conv_1",
        organizationId,
        longText,
        3,
        7,
        "vec_long",
        "2026-04-11"
      )
      .run();

    env = createMockEnv(db);
    (env.VECTORIZE as unknown as Record<string, unknown>).query = vi.fn(async () => ({
      count: 2,
      matches: [
        { id: "vec_short", score: 0.99 },
        { id: "vec_long", score: 0.88 },
      ],
    }));
  });

  it("does not return a `messages` field on search results", async () => {
    const { results } = await searchConversations(
      env as unknown as Parameters<typeof searchConversations>[0],
      organizationId,
      "greeting",
      5,
      undefined,
      undefined,
      undefined,
      0,     // minScore — allow all
      false  // dedupe off — both chunks from conv_1 should return
    );

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect((r as unknown as Record<string, unknown>).messages).toBeUndefined();
      expect(r.chunk_id).toBeTypeOf("string");
      expect(r.chunk_text).toBeTypeOf("string");
    }
  });

  it("truncates chunk_text to the snippet cap with a marker", async () => {
    const { results } = await searchConversations(
      env as unknown as Parameters<typeof searchConversations>[0],
      organizationId,
      "greeting",
      5,
      undefined,
      undefined,
      undefined,
      0,
      false
    );

    const long = results.find((r) => r.chunk_id === "chk_long");
    expect(long).toBeDefined();
    // Default snippet is 2000 chars; the 6000-char chunk should be truncated
    expect(long!.chunk_text.length).toBeLessThanOrEqual(2020);
    expect(long!.chunk_text).toContain("[truncated]");

    // Short chunks should pass through unchanged.
    const short = results.find((r) => r.chunk_id === "chk_short");
    expect(short!.chunk_text).toBe("[user]: hi\n[assistant]: hello");
  });

  it("honours a custom snippet_chars parameter", async () => {
    const { results } = await searchConversations(
      env as unknown as Parameters<typeof searchConversations>[0],
      organizationId,
      "greeting",
      5,
      undefined,
      undefined,
      200,
      0,
      false
    );

    const long = results.find((r) => r.chunk_id === "chk_long");
    expect(long!.chunk_text.length).toBeLessThanOrEqual(220);
    expect(long!.chunk_text).toContain("[truncated]");
  });

  it("caps snippet_chars at 5000", async () => {
    const { results } = await searchConversations(
      env as unknown as Parameters<typeof searchConversations>[0],
      organizationId,
      "greeting",
      5,
      undefined,
      undefined,
      999_999,
      0,
      false
    );

    const long = results.find((r) => r.chunk_id === "chk_long");
    // 6000-char text capped at 5000 — should be truncated
    expect(long!.chunk_text.length).toBeLessThanOrEqual(5020);
    expect(long!.chunk_text).toContain("[truncated]");
  });

  it("filters out results below min_score", async () => {
    const { results: allResults } = await searchConversations(
      env as unknown as Parameters<typeof searchConversations>[0],
      organizationId,
      "greeting",
      5,
      undefined,
      undefined,
      undefined,
      0,
      false
    );
    expect(allResults.length).toBe(2);
    const topScore = allResults[0].score;
    const lowScore = allResults[1].score;
    expect(topScore).toBeGreaterThan(lowScore);

    // Filter with a threshold between the two scores
    const midpoint = (topScore + lowScore) / 2;
    const { results: filtered } = await searchConversations(
      env as unknown as Parameters<typeof searchConversations>[0],
      organizationId,
      "greeting",
      5,
      undefined,
      undefined,
      undefined,
      midpoint,
      false
    );

    expect(filtered.length).toBe(1);
    expect(filtered[0].chunk_id).toBe("chk_short");
  });

  it("deduplicates chunks from the same conversation by default", async () => {
    const { results } = await searchConversations(
      env as unknown as Parameters<typeof searchConversations>[0],
      organizationId,
      "greeting",
      5,
      undefined,
      undefined,
      undefined,
      0
      // dedupe defaults to true
    );

    expect(results.length).toBe(1);
    expect(results[0].chunk_id).toBe("chk_short");
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("returns all chunks when dedupe is false", async () => {
    const { results } = await searchConversations(
      env as unknown as Parameters<typeof searchConversations>[0],
      organizationId,
      "greeting",
      5,
      undefined,
      undefined,
      undefined,
      0,
      false
    );

    expect(results.length).toBe(2);
  });
});

describe("search project filtering", () => {
  const organizationId = "org_proj";
  let db: D1Database;
  let env: ReturnType<typeof createMockEnv>;

  beforeAll(() => {
    db = createMockD1();

    // Seed conversations with different project titles
    db.prepare(
      "INSERT INTO conversations (id, organization_id, title, tags, updated_at) VALUES (?,?,?,?,?)"
    )
      .bind("conv_engram", organizationId, "engram (2026-04-12 11:37)", "[]", "2026-04-12")
      .run();
    db.prepare(
      "INSERT INTO conversations (id, organization_id, title, tags, updated_at) VALUES (?,?,?,?,?)"
    )
      .bind("conv_isleep", organizationId, "isleep (2026-04-12 11:38)", "[]", "2026-04-12")
      .run();

    // Seed chunks for each conversation
    db.prepare(
      "INSERT INTO conversation_chunks (id, conversation_id, organization_id, chunk_text, start_sequence, end_sequence, vectorize_id, created_at) VALUES (?,?,?,?,?,?,?,?)"
    )
      .bind("chk_eng", "conv_engram", organizationId, "[user]: deploy the worker", 1, 2, "vec_eng", "2026-04-12")
      .run();
    db.prepare(
      "INSERT INTO conversation_chunks (id, conversation_id, organization_id, chunk_text, start_sequence, end_sequence, vectorize_id, created_at) VALUES (?,?,?,?,?,?,?,?)"
    )
      .bind("chk_isl", "conv_isleep", organizationId, "[user]: fix the lambda crash", 1, 2, "vec_isl", "2026-04-12")
      .run();

    env = createMockEnv(db);
    (env.VECTORIZE as unknown as Record<string, unknown>).query = vi.fn(async () => ({
      count: 2,
      matches: [
        { id: "vec_eng", score: 0.95 },
        { id: "vec_isl", score: 0.90 },
      ],
    }));
  });

  it("returns results from all projects when no project filter", async () => {
    const { results } = await searchConversations(
      env as unknown as Parameters<typeof searchConversations>[0],
      organizationId,
      "deploy",
      10,
      undefined,
      undefined,
      undefined,
      0,
      true
    );

    expect(results.length).toBe(2);
  });

  it("filters to only matching project by title prefix", async () => {
    const { results } = await searchConversations(
      env as unknown as Parameters<typeof searchConversations>[0],
      organizationId,
      "deploy",
      10,
      undefined,
      undefined,
      undefined,
      0,
      true,
      "engram"
    );

    expect(results.length).toBe(1);
    expect(results[0].conversation_title).toContain("engram");
  });

  it("project filter is case-insensitive", async () => {
    const { results } = await searchConversations(
      env as unknown as Parameters<typeof searchConversations>[0],
      organizationId,
      "deploy",
      10,
      undefined,
      undefined,
      undefined,
      0,
      true,
      "Engram"
    );

    expect(results.length).toBe(1);
    expect(results[0].conversation_title).toContain("engram");
  });

  it("returns empty when no conversations match project", async () => {
    const { results } = await searchConversations(
      env as unknown as Parameters<typeof searchConversations>[0],
      organizationId,
      "deploy",
      10,
      undefined,
      undefined,
      undefined,
      0,
      true,
      "nonexistent"
    );

    expect(results.length).toBe(0);
  });
});
