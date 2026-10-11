import { describe, it, expect } from "vitest";
import { HTTPException } from "hono/http-exception";
import { appendMessages } from "../services/conversation.js";
import type { Env } from "../types.js";

/**
 * Appending to a conversation id the org does not own used to surface as a
 * blanket 500 "internal_error" (found by the Oct 2026 enterprise audit, live
 * against two scratch orgs). The lookup was always correctly org-scoped — so
 * nothing leaked and nothing was written — but a client typo and a
 * cross-tenant probe both read as a server fault, which pollutes the error
 * budget and tells an API consumer nothing.
 */
function envWithNoConversation(): Env {
  const db = {
    prepare: () => {
      const stmt = {
        bind: () => stmt,
        first: async () => null, // getConversationById finds nothing
        all: async () => ({ results: [] }),
        run: async () => ({ success: true, meta: { changes: 0 } }),
      };
      return stmt;
    },
    batch: async () => [],
  } as unknown as D1Database;
  return { DB: db } as unknown as Env;
}

describe("appendMessages against a conversation the org does not own", () => {
  it("throws a 404 HTTPException, not a bare Error that becomes a 500", async () => {
    const err = await appendMessages(
      envWithNoConversation(),
      "org_a",
      "conv_belongs_to_someone_else",
      [{ role: "user", content: "hi" }],
    ).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(HTTPException);
    expect((err as HTTPException).status).toBe(404);
    const body = (await (err as HTTPException).getResponse().json()) as {
      error: string;
      message: string;
    };
    expect(body.error).toBe("conversation_not_found");
    // Must not disclose whether the id exists under a different tenant.
    expect(JSON.stringify(body)).not.toMatch(/conv_belongs_to_someone_else/);
  });
});
