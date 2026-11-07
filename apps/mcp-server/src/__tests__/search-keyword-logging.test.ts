import { describe, it, expect, vi, afterEach } from "vitest";
import { classifyKeywordFailure, searchConversations } from "../services/search.js";
import { createMockD1, createMockEnv } from "./helpers.js";
import type { Env } from "../types.js";

/**
 * engram#564: a failed or declined keyword search is logged by kind, so it
 * can be counted, and never with the query or the error message. A search
 * query is user content, and FTS5 errors quote the MATCH they choked on.
 */

describe("classifyKeywordFailure", () => {
  it("names the class and allowlisted codes, never the message", () => {
    const cases: Array<[unknown, ReturnType<typeof classifyKeywordFailure>]> = [
      [new Error('D1_ERROR: fts5: syntax error near "private words"'), { class: "syntax", codes: ["D1_ERROR"] }],
      [new Error("D1_ERROR: unterminated string"), { class: "syntax", codes: ["D1_ERROR"] }],
      [new Error("D1_ERROR: no such column: kestrel: SQLITE_ERROR"), { class: "syntax", codes: ["D1_ERROR", "SQLITE_ERROR"] }],
      [new Error("D1 DB is overloaded. Requests queued for too long."), { class: "overloaded" }],
      [new Error("D1_ERROR: Network connection lost."), { class: "network", codes: ["D1_ERROR"] }],
      [new Error("D1_EXEC_ERROR: the query timed out"), { class: "timeout", codes: ["D1_EXEC_ERROR"] }],
      [new Error("search failed", { cause: new Error("SQLITE_BUSY: database is locked") }), { class: "d1", codes: ["SQLITE_BUSY"] }],
      [new Error("D1 storage error"), { class: "d1" }],
      // Shaped like a code but not one: user text can't ride out this way.
      [new Error("SQLITE_PRIVATE_WORDS happened"), { class: "other" }],
      [new TypeError("Cannot read properties of undefined"), { class: "other" }],
      ["a thrown string", { class: "other" }],
      [null, { class: "other" }],
      [undefined, { class: "other" }],
      [{ message: "D1_ERROR: not an Error" }, { class: "other" }],
    ];
    for (const [err, want] of cases) expect(classifyKeywordFailure(err), String(err)).toEqual(want);
  });

  it("reads at most two levels of cause", () => {
    const two = new Error("a", { cause: new Error("b", { cause: new Error("SQLITE_BUSY") }) });
    expect(classifyKeywordFailure(two)).toEqual({ class: "d1", codes: ["SQLITE_BUSY"] });
    const three = new Error("a", { cause: two });
    expect(classifyKeywordFailure(three)).toEqual({ class: "other" });
  });
});

describe("keyword search logging in searchConversations", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const QUERY = "kestrel diagnosis for Antonia";

  /**
   * A mock env whose semantic search finds chk_1, and whose keyword probe
   * either throws an FTS5-style error quoting the MATCH or reports more
   * matches than the cap.
   */
  function envWith(probe: "throw" | "too_broad") {
    const db = createMockD1();
    db.prepare("INSERT INTO conversations (id, organization_id, title, tags, updated_at) VALUES (?,?,?,?,?)")
      .bind("conv_1", "org_log", "Birds", "[]", "2026-11-01")
      .run();
    db.prepare(
      "INSERT INTO conversation_chunks (id, conversation_id, organization_id, chunk_text, start_sequence, end_sequence, vectorize_id, created_at) VALUES (?,?,?,?,?,?,?,?)",
    )
      .bind("chk_1", "conv_1", "org_log", "[user]: a kestrel\n[assistant]: noted", 1, 2, "vec_1", "2026-11-01")
      .run();
    const real = db.prepare.bind(db);
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      if (!sql.includes("chunks_fts_v2 MATCH")) return real(sql);
      return {
        bind: (...b: unknown[]) => ({
          first: async () => {
            if (probe === "throw") throw new Error(`D1_ERROR: fts5: syntax error near "${String(b[0])}": SQLITE_ERROR`);
            return { n: 1_000_000 };
          },
          all: async () => {
            throw new Error("the ranked query must not run");
          },
        }),
      };
    };
    const env = createMockEnv(db);
    (env.VECTORIZE as unknown as Record<string, unknown>).query = vi.fn(async () => ({
      count: 1,
      matches: [{ id: "vec_1", score: 0.9 }],
    }));
    return env as unknown as Env;
  }

  function captureLogs() {
    const lines: string[] = [];
    const keep = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    vi.spyOn(console, "log").mockImplementation(keep);
    vi.spyOn(console, "error").mockImplementation(keep);
    vi.spyOn(console, "warn").mockImplementation(keep);
    return lines;
  }

  it("logs a failure's class and codes, not the query or the message, and keeps the semantic results", async () => {
    const lines = captureLogs();
    const results = await searchConversations(envWith("throw"), "org_log", QUERY, 10, undefined, undefined, undefined, 0, true);
    expect(results.map((r) => r.chunk_id)).toEqual(["chk_1"]);
    expect(lines.filter((l) => l.includes("keyword search"))).toEqual([
      '[search] keyword search failed {"class":"syntax","codes":["D1_ERROR","SQLITE_ERROR"]}',
    ]);
    for (const line of lines) {
      for (const word of ["kestrel", "diagnosis", "Antonia", "syntax error near", "chunk_text"]) {
        expect(line).not.toContain(word);
      }
    }
  });

  it("logs a declined search's reason and still returns the semantic results", async () => {
    const lines = captureLogs();
    const results = await searchConversations(envWith("too_broad"), "org_log", QUERY, 10, undefined, undefined, undefined, 0, true);
    expect(results.map((r) => r.chunk_id)).toEqual(["chk_1"]);
    expect(lines.filter((l) => l.includes("keyword search"))).toEqual([
      '[search] keyword search skipped {"reason":"too_broad"}',
    ]);
  });

  it("logs a query with no searchable words as skipped, not failed", async () => {
    const lines = captureLogs();
    await searchConversations(envWith("throw"), "org_log", "the of and", 10, undefined, undefined, undefined, 0, true);
    expect(lines.filter((l) => l.includes("keyword search"))).toEqual([
      '[search] keyword search skipped {"reason":"no_terms"}',
    ]);
  });
});
