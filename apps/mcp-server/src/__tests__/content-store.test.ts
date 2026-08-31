import { describe, it, expect, vi } from "vitest";
import { createMockD1, createMockEnv } from "./helpers.js";
import { storeContent, loadContent, deleteContent } from "../services/content-store.js";
import type { Env } from "../types.js";

function env(): Env {
  return createMockEnv(createMockD1()) as unknown as Env;
}

describe("content-store", () => {
  it("stores content in R2 and round-trips it (D1 keeps only a pointer)", async () => {
    const e = env();
    const text = "hello world, this is a verbatim message";
    const { content, encoding } = await storeContent(e, "msg_a", text);
    // D1 row carries no content, just an r2 pointer
    expect(content).toBe("");
    expect(encoding).toMatch(/^r2:/);
    // loading reconstructs the original text
    const back = await loadContent(e, { id: "msg_a", content, content_encoding: encoding });
    expect(back).toBe(text);
  });

  it("round-trips large (gzipped) content through R2", async () => {
    const e = env();
    const text = "verbatim ".repeat(500); // > compression threshold
    const { content, encoding } = await storeContent(e, "msg_big", text);
    expect(content).toBe("");
    expect(encoding).toBe("r2:gzip+base64");
    expect(await loadContent(e, { id: "msg_big", content, content_encoding: encoding })).toBe(text);
  });

  it("falls back to INLINE D1 storage (no data loss) when R2 write fails", async () => {
    const e = env();
    (e.CONTENT.put as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error("R2 down");
    });
    const text = "content that must survive an R2 outage";
    const { content, encoding } = await storeContent(e, "msg_fallback", text);
    // Content is kept inline in D1 — NOT empty, not lost
    expect(content).toBe(text); // short text stored raw
    expect(encoding?.startsWith("r2:") ?? false).toBe(false); // inline, not an R2 pointer
    // and reads still work off the inline value
    expect(await loadContent(e, { id: "msg_fallback", content, content_encoding: encoding })).toBe(text);
  });

  it("reads legacy inline content unchanged", async () => {
    const e = env();
    expect(await loadContent(e, { id: "msg_legacy", content: "old inline text", content_encoding: null })).toBe(
      "old inline text",
    );
  });

  it("throws loudly (never returns empty) if an r2-marked object is missing", async () => {
    const e = env();
    await expect(
      loadContent(e, { id: "msg_missing", content: "", content_encoding: "r2:raw" }),
    ).rejects.toThrow(/missing/);
  });
});

/**
 * Deletion used to stop at D1 and Vectorize, leaving the verbatim text in R2
 * forever — invisible to the owner, still stored by us, and in direct
 * conflict with the erasure commitment in the published DPA.
 */
describe("deleteContent", () => {
  function storeOf(e: Env): Map<string, string> {
    return (e as unknown as { __r2store: Map<string, string> }).__r2store;
  }

  it("actually removes the object, not just the pointer", async () => {
    const e = env();
    await storeContent(e, "msg_gone", "sensitive client detail");
    expect(storeOf(e).has("content/msg_gone")).toBe(true);

    const n = await deleteContent(e, ["msg_gone"]);
    expect(n).toBe(1);
    // The bucket, not the mock's call log — this is the assertion that
    // would have caught the original bug.
    expect(storeOf(e).has("content/msg_gone")).toBe(false);
  });

  it("deletes only the ids given, leaving other users' objects alone", async () => {
    const e = env();
    await storeContent(e, "msg_mine", "mine");
    await storeContent(e, "msg_theirs", "theirs");

    await deleteContent(e, ["msg_mine"]);

    expect(storeOf(e).has("content/msg_mine")).toBe(false);
    expect(storeOf(e).has("content/msg_theirs")).toBe(true);
  });

  it("batches past R2's 1000-key limit", async () => {
    const e = env();
    const ids = Array.from({ length: 2500 }, (_, i) => `msg_${i}`);
    for (const id of ids) await storeContent(e, id, `body ${id}`);

    const n = await deleteContent(e, ids);

    expect(n).toBe(2500);
    expect(storeOf(e).size).toBe(0);
    // 2500 keys => 3 calls (1000 + 1000 + 500), none over the limit.
    const del = e.CONTENT.delete as unknown as ReturnType<typeof vi.fn>;
    expect(del.mock.calls.length).toBe(3);
    for (const [arg] of del.mock.calls) {
      expect((arg as string[]).length).toBeLessThanOrEqual(1000);
    }
  });

  it("throws instead of silently succeeding when R2 is unavailable", async () => {
    const e = env();
    await storeContent(e, "msg_stuck", "must not be reported as deleted");
    (e.CONTENT.delete as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => {
        throw new Error("R2 down");
      },
    );

    // Reporting success here would tell a user their data is gone while it
    // is still in the bucket. Callers rely on this throwing to abort.
    await expect(deleteContent(e, ["msg_stuck"])).rejects.toThrow(/R2 down/);
    expect(storeOf(e).has("content/msg_stuck")).toBe(true);
  });

  it("is a no-op for an empty id list", async () => {
    const e = env();
    expect(await deleteContent(e, [])).toBe(0);
    expect((e.CONTENT.delete as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });
});
