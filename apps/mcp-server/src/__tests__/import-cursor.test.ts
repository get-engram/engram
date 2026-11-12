import { describe, it, expect } from "vitest";
import { importStartsAt, parseImportCursor, takeImportCursor, IMPORT_CURSOR_KEY } from "../services/import-cursor.js";

// engram#751: `engram import` marks how far it got on the last message of
// each batch it sends. These are the rules for reading that marker; the
// tests against real SQLite (import-cursor.d1.test.ts) cover recording it.

const DIGEST = "0123456789abcdef".repeat(4);
const cursor = (next: number, digest = DIGEST) => ({ v: 1, next, digest });

describe("parseImportCursor accepts only the CLI's own shape", () => {
  it("accepts a cursor exactly as the CLI writes it", () => {
    expect(parseImportCursor(cursor(1))).toEqual({ v: 1, next: 1, digest: DIGEST });
    expect(parseImportCursor(cursor(250))).toEqual({ v: 1, next: 250, digest: DIGEST });
  });

  it("keeps only the fields it knows, so what's recorded stays the same small size", () => {
    expect(parseImportCursor({ ...cursor(3), note: "x".repeat(10_000) })).toEqual({ v: 1, next: 3, digest: DIGEST });
  });

  it("rejects anything that isn't an object", () => {
    for (const value of [undefined, null, 3, "cursor", true, [cursor(3)]]) {
      expect(parseImportCursor(value)).toBeNull();
    }
  });

  it("rejects another version", () => {
    expect(parseImportCursor({ ...cursor(3), v: 2 })).toBeNull();
    expect(parseImportCursor({ ...cursor(3), v: "1" })).toBeNull();
    expect(parseImportCursor({ next: 3, digest: DIGEST })).toBeNull();
  });

  it("rejects a count that isn't a whole number of messages, at least one", () => {
    for (const next of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(parseImportCursor(cursor(next))).toBeNull();
    }
    expect(parseImportCursor({ ...cursor(3), next: "3" })).toBeNull();
    expect(parseImportCursor({ v: 1, digest: DIGEST })).toBeNull();
  });

  it("rejects a digest that isn't a lowercase hex SHA-256", () => {
    for (const digest of [DIGEST.toUpperCase(), DIGEST.slice(1), `${DIGEST}0`, `${DIGEST.slice(1)}g`, ""]) {
      expect(parseImportCursor(cursor(3, digest))).toBeNull();
    }
    expect(parseImportCursor({ v: 1, next: 3 })).toBeNull();
    expect(parseImportCursor({ v: 1, next: 3, digest: 42 })).toBeNull();
  });
});

describe("takeImportCursor takes the marker off the messages", () => {
  type M = { role: string; content: string; metadata?: Record<string, unknown> };
  const msg = (content: string, metadata?: Record<string, unknown>): M =>
    metadata === undefined ? { role: "user", content } : { role: "user", content, metadata };

  it("returns the last message's cursor and stores that message without it", () => {
    const { messages, cursor: taken } = takeImportCursor([
      msg("one"),
      msg("two", { [IMPORT_CURSOR_KEY]: cursor(2), model: "m-1" }),
    ]);
    expect(taken).toEqual(cursor(2));
    expect(messages).toEqual([msg("one"), msg("two", { model: "m-1" })]);
  });

  it("leaves the caller's messages as they were", () => {
    const input = [msg("one", { [IMPORT_CURSOR_KEY]: cursor(1) })];
    takeImportCursor(input);
    expect(input[0].metadata).toEqual({ [IMPORT_CURSOR_KEY]: cursor(1) });
  });

  it("drops a cursor on any message but the last: only the last marks where the batch is stored", () => {
    const { messages, cursor: taken } = takeImportCursor([
      msg("one", { [IMPORT_CURSOR_KEY]: cursor(1), keep: true }),
      msg("two"),
    ]);
    expect(taken).toBeNull();
    expect(messages).toEqual([msg("one", { keep: true }), msg("two")]);
  });

  it("drops a cursor that counts fewer messages than the batch it ends", () => {
    const { messages, cursor: taken } = takeImportCursor([msg("one"), msg("two", { [IMPORT_CURSOR_KEY]: cursor(1) })]);
    expect(taken).toBeNull();
    expect(messages).toEqual([msg("one"), msg("two", {})]);
    expect(takeImportCursor([msg("one"), msg("two", { [IMPORT_CURSOR_KEY]: cursor(2) })]).cursor).toEqual(cursor(2));
  });

  it("drops a cursor that isn't the CLI's shape, and still never stores it on the message", () => {
    for (const bad of [{ v: 1, next: 0, digest: DIGEST }, "3", null, { next: 3 }]) {
      const { messages, cursor: taken } = takeImportCursor([msg("one", { [IMPORT_CURSOR_KEY]: bad })]);
      expect(taken).toBeNull();
      expect(messages).toEqual([msg("one", {})]);
    }
  });

  it("returns a message with no cursor as the same object, and no cursor for no messages", () => {
    const plain = msg("one", { model: "m-1" });
    const bare = msg("two");
    const { messages, cursor: taken } = takeImportCursor([plain, bare]);
    expect(taken).toBeNull();
    expect(messages[0]).toBe(plain);
    expect(messages[1]).toBe(bare);
    expect(takeImportCursor([])).toEqual({ messages: [], cursor: null });
  });
});

describe("importStartsAt: where an import's next batch must start", () => {
  const row = (metadata: unknown, messageCount: number) => ({
    metadata: typeof metadata === "string" || metadata === null ? metadata : JSON.stringify(metadata),
    message_count: messageCount,
  });

  it("at the recorded cursor, whatever the count", () => {
    expect(importStartsAt(row({ import_cursor: cursor(5) }, 3), 5)).toBe(true);
    expect(importStartsAt(row({ import_cursor: cursor(5) }, 3), 3)).toBe(false);
    expect(importStartsAt(row({ import_cursor: cursor(5) }, 5), 4)).toBe(false);
    expect(importStartsAt(row({ import_cursor: cursor(5) }, 5), 6)).toBe(false);
  });

  it("with no cursor recorded, or one without a whole-number next, at the message count", () => {
    for (const metadata of [{}, { source: "x" }, { import_cursor: "5" }, { import_cursor: [5] }, { import_cursor: null }, { import_cursor: { next: 5.5 } }, { import_cursor: { next: "5" } }]) {
      expect(importStartsAt(row(metadata, 3), 3)).toBe(true);
      expect(importStartsAt(row(metadata, 3), 5)).toBe(false);
      expect(importStartsAt(row(metadata, 3), 0)).toBe(false);
    }
  });

  it("anywhere, where the metadata isn't a JSON object: no cursor can be recorded there", () => {
    for (const metadata of ["[1,2]", '"text"', "7", "null", "{not json", "", null]) {
      expect(importStartsAt(row(metadata, 3), 0)).toBe(true);
      expect(importStartsAt(row(metadata, 3), 9)).toBe(true);
    }
  });
});
