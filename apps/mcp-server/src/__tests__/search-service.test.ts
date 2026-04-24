import { describe, it, expect, beforeAll, vi } from "vitest";
import { createMockD1, createMockEnv } from "./helpers.js";
import {
  searchConversations,
  DEFAULT_SNIPPET_CHARS,
  DEFAULT_MIN_SCORE,
  MAX_SNIPPET_CHARS,
} from "../services/search.js";

// Covers the shape changes from issue #8: search responses must drop
// the structured `messages` field entirely, and must truncate chunk_text
// to the snippet_chars cap so a single result can never dominate the
// response.
describe("search service", () => {
  const organizationId = "org_search";
  let db: D1Database;
  let env: ReturnType<typeof createMockEnv>;

  beforeAll(() => {
    db = createMockD1();

    // Seed two chunks: one short, one well over the default snippet cap.
    const longText = "a".repeat(DEFAULT_SNIPPET_CHARS * 3);
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
    env.VECTORIZE.query = vi.fn(async () => ({
      matches: [
        { id: "vec_short", score: 0.99 },
        { id: "vec_long", score: 0.88 },
      ],
    }));
  });

  it("does not return a `messages` field on search results", async () => {
    const results = await searchConversations(
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
      // The whole point of the bloat fix — `messages` must be gone.
      expect((r as unknown as Record<string, unknown>).messages).toBeUndefined();
      expect(r.chunk_id).toBeTypeOf("string");
      expect(r.chunk_text).toBeTypeOf("string");
    }
  });

  it("truncates chunk_text to the default snippet cap with a marker", async () => {
    const results = await searchConversations(
      env as unknown as Parameters<typeof searchConversations>[0],
      organizationId,
      "greeting",
      5,
      undefined,
      undefined,
      undefined,
      0,     // minScore
      false  // dedupe off
    );

    const long = results.find((r) => r.chunk_id === "chk_long");
    expect(long).toBeDefined();
    expect(long!.chunk_text.length).toBeLessThanOrEqual(
      DEFAULT_SNIPPET_CHARS + 20 /* marker overhead */
    );
    expect(long!.chunk_text).toContain("[truncated]");

    // Short chunks should pass through unchanged.
    const short = results.find((r) => r.chunk_id === "chk_short");
    expect(short!.chunk_text).toBe("[user]: hi\n[assistant]: hello");
  });

  it("honours a custom snippet_chars parameter", async () => {
    const results = await searchConversations(
      env as unknown as Parameters<typeof searchConversations>[0],
      organizationId,
      "greeting",
      5,
      undefined,
      undefined,
      200,
      0,     // minScore
      false  // dedupe off
    );

    const long = results.find((r) => r.chunk_id === "chk_long");
    expect(long!.chunk_text.length).toBeLessThanOrEqual(200 + 20);
    expect(long!.chunk_text).toContain("[truncated]");
  });

  it("caps snippet_chars at MAX_SNIPPET_CHARS", async () => {
    // Asking for 999_999 should silently clamp, not throw.
    const results = await searchConversations(
      env as unknown as Parameters<typeof searchConversations>[0],
      organizationId,
      "greeting",
      5,
      undefined,
      undefined,
      999_999,
      0,     // minScore
      false  // dedupe off
    );

    const long = results.find((r) => r.chunk_id === "chk_long");
    // The seed longText is 3× the default, which is 2400 chars < 5000,
    // so with the cap at MAX the long chunk should NOT be truncated.
    expect(long!.chunk_text).not.toContain("[truncated]");
    expect(long!.chunk_text.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS);
  });

  it("filters out results below min_score", async () => {
    // With RRF normalization, rank-0 vector-only result scores ~0.5
    // and rank-1 scores slightly less. Use a threshold that splits them.
    const allResults = await searchConversations(
      env as unknown as Parameters<typeof searchConversations>[0],
      organizationId,
      "greeting",
      5,
      undefined,
      undefined,
      undefined,
      0,     // get all first
      false
    );
    // Both should exist with different scores
    expect(allResults.length).toBe(2);
    const topScore = allResults[0].score;
    const lowScore = allResults[1].score;
    expect(topScore).toBeGreaterThan(lowScore);

    // Now filter with a threshold between the two scores
    const midpoint = (topScore + lowScore) / 2;
    const filtered = await searchConversations(
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
    // Both chunks are from conv_1. With dedupe on, only the top-scoring one returns.
    const results = await searchConversations(
      env as unknown as Parameters<typeof searchConversations>[0],
      organizationId,
      "greeting",
      5,
      undefined,
      undefined,
      undefined,
      0  // minScore — allow all
      // dedupe defaults to true
    );

    expect(results.length).toBe(1);
    // Highest score wins
    expect(results[0].chunk_id).toBe("chk_short");
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("returns all chunks when dedupe is false", async () => {
    const results = await searchConversations(
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
