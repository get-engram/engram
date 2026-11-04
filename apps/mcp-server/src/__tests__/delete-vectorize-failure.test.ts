import { describe, it, expect, vi } from "vitest";
import { insertConversation, getConversationById } from "@getengram/db";
import { createMockD1, createMockEnv } from "./helpers.js";
import { deleteConversation } from "../services/conversation.js";
import type { Env } from "../types.js";

/**
 * engram#542: deleting a conversation with more than 100 chunks threw
 * VECTOR_DELETE_ERROR (code 40007) from Vectorize AFTER the R2 bodies had
 * been purged. The conversation stayed listed with every message a
 * placeholder, and the retry failed identically. The 100-id batching
 * (0125d53) removed that trigger; these tests pin the ordering guarantee
 * behind it: whatever Vectorize does, the delete finishes.
 */
const ORG = "org_542";

async function seed(env: ReturnType<typeof createMockEnv>, convId: string, chunks: number) {
  await insertConversation(env.DB, convId, ORG, "Large conversation", null, [], {});
  await env.DB.prepare(
    "INSERT INTO messages (id, conversation_id, organization_id, role, content, content_encoding, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(`msg_${convId}`, convId, ORG, "user", "", "r2:raw", 1)
    .run();
  env.__r2store.set(`content/msg_${convId}`, "the body");
  for (let i = 0; i < chunks; i++) {
    const id = `chk_${convId}_${i}_${i}_0`;
    await env.DB.prepare(
      "INSERT INTO conversation_chunks (id, conversation_id, organization_id, chunk_text, start_sequence, end_sequence, vectorize_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(id, convId, ORG, "[user]: x", i, i, id)
      .run();
  }
}

describe("deleteConversation when Vectorize rejects (engram#542)", () => {
  it("still removes the conversation from D1 after purging R2", async () => {
    const db = createMockD1();
    const env = createMockEnv(db);
    await seed(env, "conv_542_a", 120);
    env.VECTORIZE.deleteByIds = vi.fn(async () => {
      throw new Error("VECTOR_DELETE_ERROR (code = 40007)");
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const ok = await deleteConversation(env as unknown as Env, ORG, "conv_542_a");

    expect(ok).toBe(true);
    expect(await getConversationById(db, "conv_542_a", ORG)).toBeNull();
    expect(env.__r2store.has("content/msg_conv_542_a")).toBe(false);
    // Tried, retried, then reported — never swallowed silently.
    expect(env.VECTORIZE.deleteByIds).toHaveBeenCalledTimes(2);
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining("Vectorize delete failed twice for conversation conv_542_a")
    );
    errors.mockRestore();
  });

  it("retries once and stays quiet when the retry succeeds", async () => {
    const db = createMockD1();
    const env = createMockEnv(db);
    await seed(env, "conv_542_b", 3);
    let calls = 0;
    env.VECTORIZE.deleteByIds = vi.fn(async (ids: string[]) => {
      if (calls++ === 0) throw new Error("transient");
      return { ids, count: ids.length };
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const ok = await deleteConversation(env as unknown as Env, ORG, "conv_542_b");

    expect(ok).toBe(true);
    expect(await getConversationById(db, "conv_542_b", ORG)).toBeNull();
    expect(env.VECTORIZE.deleteByIds).toHaveBeenCalledTimes(2);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
