import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { stripBodyFields } from "../services/privacy.js";
import { account } from "../routes/account.js";
import type { Env, AuthContext } from "../types.js";
import type { Scope } from "../mcp/scopes.js";

/**
 * Regressions for the findings of the 2026-10-11 enterprise audit, each of
 * which was reproduced against production before being fixed.
 */

// ── the privacy leak ─────────────────────────────────────────────────────

describe("stripBodyFields", () => {
  it("removes chunk_summary as well as chunk_text", () => {
    // chunk_summary is a whitespace-normalised truncation of the chunk, so
    // for anything short it IS the message. A stored password came back in
    // full through this field with 'Share full message bodies' switched off.
    const rows = [
      {
        chunk_id: "chk_1",
        conversation_id: "conv_1",
        conversation_title: "notes",
        tags: ["a"],
        chunk_text: "my bank password is hunter2 and the account is 4471",
        chunk_summary: "my bank password is hunter2 and the account is 4471",
        score: 0.9,
        start_sequence: 1,
        end_sequence: 1,
      },
    ];
    const out = stripBodyFields(rows);
    expect(JSON.stringify(out)).not.toMatch(/hunter2/);
    expect(out[0]).not.toHaveProperty("chunk_summary");
    expect(out[0]).not.toHaveProperty("chunk_text");
    // the promised metadata survives: titles, tags, timestamps, score
    expect(out[0]).toMatchObject({
      chunk_id: "chk_1",
      conversation_id: "conv_1",
      conversation_title: "notes",
      tags: ["a"],
      score: 0.9,
    });
  });

  it("is a no-op on rows that carry neither field", () => {
    expect(stripBodyFields([{ chunk_id: "x" }])).toEqual([{ chunk_id: "x" }]);
  });
});

// ── the account-lifecycle gates ──────────────────────────────────────────

function stubDb() {
  const db = {
    prepare: () => {
      const stmt = {
        bind: () => stmt,
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ success: true, meta: { changes: 1 } }),
      };
      return stmt;
    },
    batch: async () => [],
  } as unknown as D1Database;
  return db;
}

function appFor(auth: AuthContext) {
  const db = stubDb();
  const a = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
  a.use("*", async (c, next) => {
    c.set("auth", auth);
    await next();
  });
  a.route("/api/account", account);
  return { app: a, env: { DB: db } as unknown as Env };
}

const OWNER_FULL: AuthContext = {
  organizationId: "org_1",
  apiKeyId: "key_owner",
  tier: "free",
  scopes: ["read", "write", "search", "delete"] as Scope[],
  seatId: null,
};
const READ_ONLY: AuthContext = { ...OWNER_FULL, apiKeyId: "key_ro", scopes: ["read", "search"] as Scope[] };
const CONNECTOR: AuthContext = { ...OWNER_FULL, apiKeyId: "oauth:client_chatgpt" };

const MUTATIONS: Array<[string, string, string | undefined]> = [
  ["DELETE", "/api/account", undefined],
  ["POST", "/api/account/restore", undefined],
  ["PATCH", "/api/account", JSON.stringify({ email: "new@example.com" })],
];

describe("account lifecycle is first-party and write-level", () => {
  it.each(MUTATIONS)("refuses a READ-ONLY key on %s %s", async (method, path, body) => {
    const { app, env } = appFor(READ_ONLY);
    const res = await app.request(path, { method, body, headers: { "content-type": "application/json" } }, env);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("insufficient_scope");
  });

  it.each(MUTATIONS)("refuses an OAUTH CONNECTOR on %s %s", async (method, path, body) => {
    const { app, env } = appFor(CONNECTOR);
    const res = await app.request(path, { method, body, headers: { "content-type": "application/json" } }, env);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("forbidden");
  });

  it("refuses a Team member's seat key on the email change", async () => {
    const { app, env } = appFor({ ...OWNER_FULL, seatId: "seat_1" });
    const res = await app.request(
      "/api/account",
      { method: "PATCH", body: JSON.stringify({ email: "x@y.com" }), headers: { "content-type": "application/json" } },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("still lets a read-only key read whoami — that is the key-validation path", async () => {
    const { app, env } = appFor(READ_ONLY);
    const res = await app.request("/api/account", {}, env);
    expect(res.status).not.toBe(403);
  });
});
