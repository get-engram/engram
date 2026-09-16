import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { seats } from "../routes/seats.js";
import { account } from "../routes/account.js";
import type { Env, AuthContext } from "../types.js";
import {
  MAX_MESSAGE_CONTENT_CHARS,
  MAX_MESSAGES_PER_APPEND,
} from "@getengram/shared";
import { boundMessageContent } from "../services/conversation.js";

// P0 hardening guards (2026-09-16 audit). These pin the owner-vs-seat boundary
// on destructive org routes and the byte caps on the write path — both classes
// the audit flagged as "invariant enforced by convention, not construction".

type Vars = { Variables: { auth: AuthContext }; Bindings: Env };

function appAs(auth: Partial<AuthContext>, mount: (a: Hono<Vars>) => void) {
  const app = new Hono<Vars>();
  app.use("*", async (c, next) => {
    c.set("auth", {
      organizationId: "org_test",
      apiKeyId: "key_test",
      tier: "team",
      scopes: ["read", "write", "search", "delete"],
      ...auth,
    } as AuthContext);
    await next();
  });
  mount(app);
  return app;
}

describe("owner-only guards on destructive org routes", () => {
  it("rejects a seat-bound key deleting the account (403)", async () => {
    const app = appAs({ seatId: "seat_member" }, (a) => a.route("/account", account));
    const res = await app.request("/account", { method: "DELETE" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("forbidden");
  });

  it("rejects a seat-bound key inviting a seat (403)", async () => {
    const app = appAs({ seatId: "seat_member" }, (a) => a.route("/seats", seats));
    const res = await app.request("/seats", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "x@y.com" }),
    });
    expect(res.status).toBe(403);
  });

  it("lets an OWNER key (null seatId) past the guard — not a 403", async () => {
    const app = appAs({ seatId: null }, (a) => a.route("/seats", seats));
    const res = await app.request("/seats", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "x@y.com" }),
    });
    // It will fail later (no DB bound), but it must NOT be the ownership 403.
    expect(res.status).not.toBe(403);
  });
});

describe("write-path byte caps are real numbers", () => {
  it("caps message content and batch size to bounded ceilings", () => {
    expect(MAX_MESSAGE_CONTENT_CHARS).toBeGreaterThan(0);
    expect(MAX_MESSAGE_CONTENT_CHARS).toBeLessThanOrEqual(200_000);
    expect(MAX_MESSAGES_PER_APPEND).toBeGreaterThan(0);
    expect(MAX_MESSAGES_PER_APPEND).toBeLessThanOrEqual(1_000);
  });
});

describe("oversized content is truncated, not rejected (CLI sync safety)", () => {
  it("truncates a huge single message with a visible marker and leaves normal ones untouched", () => {
    const huge = "x".repeat(MAX_MESSAGE_CONTENT_CHARS + 5_000);
    const out = boundMessageContent([
      { role: "user", content: "small" },
      { role: "assistant", content: huge },
    ]);
    // Small message is verbatim.
    expect(out[0].content).toBe("small");
    // Huge message is bounded and marked — never rejected.
    expect(out[1].content.length).toBeLessThan(huge.length);
    expect(out[1].content.startsWith("x".repeat(1000))).toBe(true);
    expect(out[1].content).toContain("truncated");
  });

  it("is a no-op for content at or under the cap", () => {
    const exact = "y".repeat(MAX_MESSAGE_CONTENT_CHARS);
    const out = boundMessageContent([{ role: "user", content: exact }]);
    expect(out[0].content).toBe(exact);
  });
});
