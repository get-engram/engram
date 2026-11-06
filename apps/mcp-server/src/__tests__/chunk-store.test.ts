import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import {
  CHUNK_R2_ENCODING,
  chunkObjectKey,
  conversationChunkPrefix,
  copyChunkTextsToR2,
  deleteChunkObjects,
  deleteConversationChunkObjects,
  isTextInR2Only,
  loadChunkTexts,
  putChunkText,
  putChunkTexts,
} from "../services/chunk-store.js";
import { createMockD1, createMockEnv } from "./helpers.js";
import type { Env } from "../types.js";

/**
 * engram#384, the R2 side of chunk text: key layout, checksummed puts, the
 * reader that resolves a row's text from its column or its object, and the
 * deletes that must throw. Real-SQLite + real-R2 behaviour is in
 * chunk-text-r2.d1.test.ts.
 */

type MockEnv = ReturnType<typeof createMockEnv>;
const mockEnv = (): MockEnv => createMockEnv(createMockD1());
const asEnv = (env: MockEnv) => env as unknown as Env;
// The helper types the bucket as R2Bucket; reach its vi.fn methods through this.
type Fn = ReturnType<typeof vi.fn>;
const chunks = (env: MockEnv) => env.CHUNKS as unknown as Record<"put" | "get" | "head" | "delete" | "list", Fn>;
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chunk object keys", () => {
  it("keys a chunk under its conversation", () => {
    expect(chunkObjectKey("conv_1", "chk_conv_1_1_4_0")).toBe("conv_1/chk_conv_1_1_4_0");
    expect(conversationChunkPrefix("conv_1")).toBe("conv_1/");
  });

  it("refuses ids that are empty or could cross into another prefix", () => {
    for (const [conv, chunk] of [
      ["", "c"],
      ["conv", ""],
      ["conv/x", "c"],
      ["conv", "c/../d"],
    ]) {
      expect(() => chunkObjectKey(conv, chunk)).toThrow(/refusing chunk key/);
    }
    expect(() => conversationChunkPrefix("")).toThrow(/refusing chunk prefix/);
    expect(() => conversationChunkPrefix("a/b")).toThrow(/refusing chunk prefix/);
  });

  it("treats only an empty column with an r2:* encoding as moved", () => {
    expect(isTextInR2Only({ chunk_text: "", chunk_encoding: "r2:raw" })).toBe(true);
    expect(isTextInR2Only({ chunk_text: "", chunk_encoding: null })).toBe(false);
    expect(isTextInR2Only({ chunk_text: "", chunk_encoding: undefined })).toBe(false);
    expect(isTextInR2Only({ chunk_text: "text", chunk_encoding: "r2:raw" })).toBe(false);
  });
});

describe("putting chunk text", () => {
  it("sends the SHA-256 of the exact UTF-8 text, so R2 rejects an altered upload", async () => {
    const env = mockEnv();
    const text = "[user]: naïve café — 東京 🙂";
    await putChunkText(asEnv(env), "conv/c", text);
    const [key, body, opts] = chunks(env).put.mock.calls[0] as unknown as [string, string, R2PutOptions];
    expect(key).toBe("conv/c");
    expect(body).toBe(text);
    expect(opts.sha256).toBe(sha(text));
    expect((opts.httpMetadata as R2HTTPMetadata).contentType).toBe("text/plain; charset=utf-8");
  });

  it("retries a failed put once and reports what failed twice, without throwing", async () => {
    const env = mockEnv();
    const attempts = new Map<string, number>();
    chunks(env).put.mockImplementation(async (key: string) => {
      const n = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, n);
      if (key === "conv/flaky" && n === 1) throw new Error("blip");
      if (key === "conv/down") throw new Error("R2 down");
      return {};
    });
    const failed = await putChunkTexts(
      asEnv(env),
      [
        { key: "conv/ok", text: "a" },
        { key: "conv/flaky", text: "b" },
        { key: "conv/down", text: "c" },
      ],
      2,
    );
    expect(failed).toEqual([{ key: "conv/down", error: "R2 down" }]);
    expect(attempts.get("conv/ok")).toBe(1);
    expect(attempts.get("conv/flaky")).toBe(2);
    expect(attempts.get("conv/down")).toBe(2);
  });

  it("never fails a save: the copy logs and returns when R2 is down or an id is bad", async () => {
    const env = mockEnv();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    chunks(env).put.mockImplementation(async () => {
      throw new Error("R2 down");
    });
    await expect(
      copyChunkTextsToR2(asEnv(env), "conv", [{ id: "c1", text: "a" }, { id: "c2", text: "b" }]),
    ).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith(expect.stringContaining("2/2 chunk copies failed for conv"));

    await expect(
      copyChunkTextsToR2(asEnv(env), "conv", [{ id: "bad/id", text: "a" }]),
    ).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith(expect.stringContaining("chunk copy failed for conv"));
  });

  it("does nothing for a save with no chunks", async () => {
    const env = mockEnv();
    await copyChunkTextsToR2(asEnv(env), "conv", []);
    expect(env.CHUNKS.put).not.toHaveBeenCalled();
  });
});

describe("loading chunk text", () => {
  it("reads the column for rows still holding text, and R2 only for moved rows", async () => {
    const env = mockEnv();
    env.__chunkStore.set("conv/moved", "moved text");
    const texts = await loadChunkTexts(asEnv(env), [
      { id: "inline", conversation_id: "conv", chunk_text: "inline text", chunk_encoding: null },
      // An empty window is still inline: no encoding, so the column is the text.
      { id: "empty", conversation_id: "conv", chunk_text: "", chunk_encoding: null },
      { id: "moved", conversation_id: "conv", chunk_text: "", chunk_encoding: CHUNK_R2_ENCODING },
    ]);
    expect([...texts.entries()].sort()).toEqual([
      ["empty", ""],
      ["inline", "inline text"],
      ["moved", "moved text"],
    ]);
    expect(env.CHUNKS.get).toHaveBeenCalledTimes(1);
    expect(env.CHUNKS.get).toHaveBeenCalledWith("conv/moved");
  });

  it("leaves out a moved row whose object is missing, unreadable, or in an unknown encoding", async () => {
    const env = mockEnv();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    env.__chunkStore.set("conv/future", "stored some newer way");
    env.__chunkStore.set("conv/throws", "unreachable");
    const realGet = chunks(env).get.getMockImplementation() as (key: string) => Promise<unknown>;
    chunks(env).get.mockImplementation(async (key: string) => {
      if (key === "conv/throws") throw new Error("R2 timeout");
      return realGet(key);
    });
    const texts = await loadChunkTexts(asEnv(env), [
      { id: "gone", conversation_id: "conv", chunk_text: "", chunk_encoding: CHUNK_R2_ENCODING },
      { id: "future", conversation_id: "conv", chunk_text: "", chunk_encoding: "r2:gzip" },
      { id: "throws", conversation_id: "conv", chunk_text: "", chunk_encoding: CHUNK_R2_ENCODING },
      { id: "fine", conversation_id: "conv", chunk_text: "still here", chunk_encoding: null },
    ]);
    expect([...texts.keys()]).toEqual(["fine"]);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("R2 object missing for cleared chunk gone"));
    expect(err).toHaveBeenCalledWith(expect.stringContaining("unknown chunk_encoding r2:gzip on chunk future"));
    expect(err).toHaveBeenCalledWith(expect.stringContaining("R2 read failed for chunk throws"));
  });
});

describe("deleting chunk objects", () => {
  it("deletes in calls of at most 1000 keys", async () => {
    const env = mockEnv();
    const keys = Array.from({ length: 2500 }, (_, i) => `conv/c${i}`);
    for (const k of keys) env.__chunkStore.set(k, "x");
    expect(await deleteChunkObjects(asEnv(env), keys)).toBe(2500);
    expect(chunks(env).delete.mock.calls.map((c) => (c[0] as string[]).length)).toEqual([1000, 1000, 500]);
    expect(env.__chunkStore.size).toBe(0);
  });

  it("throws when R2 refuses, so the caller aborts before its rows go", async () => {
    const env = mockEnv();
    chunks(env).delete.mockImplementation(async () => {
      throw new Error("R2 down");
    });
    await expect(deleteChunkObjects(asEnv(env), ["conv/c"])).rejects.toThrow("R2 down");
  });

  it("sweeps one conversation's prefix, however many pages, and nothing beside it", async () => {
    const env = mockEnv();
    for (let i = 0; i < 2300; i++) env.__chunkStore.set(`conv_a/c${i}`, "x");
    // Shares the prefix as a string but is a different conversation.
    env.__chunkStore.set("conv_ab/c0", "keep");
    env.__chunkStore.set("conv_b/c0", "keep");
    expect(await deleteConversationChunkObjects(asEnv(env), "conv_a")).toBe(2300);
    expect([...env.__chunkStore.keys()].sort()).toEqual(["conv_ab/c0", "conv_b/c0"]);
    expect(env.CHUNKS.list).toHaveBeenCalledWith({ prefix: "conv_a/", limit: 1000 });
  });

  it("returns 0 for a conversation with no objects", async () => {
    const env = mockEnv();
    expect(await deleteConversationChunkObjects(asEnv(env), "conv_none")).toBe(0);
  });

  it("throws instead of looping when a delete leaves the listing unchanged", async () => {
    const env = mockEnv();
    env.__chunkStore.set("conv_a/c0", "x");
    chunks(env).delete.mockImplementation(async () => {});
    await expect(deleteConversationChunkObjects(asEnv(env), "conv_a")).rejects.toThrow(/made no progress/);
  });
});
