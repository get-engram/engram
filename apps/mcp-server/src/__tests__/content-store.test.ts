import { describe, it, expect, vi } from "vitest";
import { createMockD1, createMockEnv } from "./helpers.js";
import { storeContent, loadContent } from "../services/content-store.js";
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
