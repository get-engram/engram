import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { admin } from "../routes/admin.js";
import { createMockD1, createMockEnv } from "./helpers.js";
import type { Env } from "../types.js";

// ADMIN_SECRET auth lives in index.ts middleware; mounting the router
// directly tests the handler logic (same approach as export.test.ts).
function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/admin", admin);
  return app;
}

describe("PATCH /admin/users/:id — retention_policy_days", () => {
  it("rejects a window below the 7-day floor", async () => {
    const env = createMockEnv(createMockD1());
    const res = await createApp().request(
      "/admin/users/org_x",
      {
        method: "PATCH",
        body: JSON.stringify({ retention_policy_days: 3 }),
        headers: { "Content-Type": "application/json" },
      },
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; min: number };
    expect(body.error).toBe("invalid_retention_policy_days");
    expect(body.min).toBe(7);
  });

  it("rejects a non-integer window", async () => {
    const env = createMockEnv(createMockD1());
    const res = await createApp().request(
      "/admin/users/org_x",
      {
        method: "PATCH",
        body: JSON.stringify({ retention_policy_days: 30.5 }),
        headers: { "Content-Type": "application/json" },
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("accepts a valid window", async () => {
    const env = createMockEnv(createMockD1());
    const res = await createApp().request(
      "/admin/users/org_x",
      {
        method: "PATCH",
        body: JSON.stringify({ retention_policy_days: 90 }),
        headers: { "Content-Type": "application/json" },
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { updated: boolean; retention_policy_days: number };
    expect(body.updated).toBe(true);
    expect(body.retention_policy_days).toBe(90);
  });

  it("accepts null to clear the policy", async () => {
    const env = createMockEnv(createMockD1());
    const res = await createApp().request(
      "/admin/users/org_x",
      {
        method: "PATCH",
        body: JSON.stringify({ retention_policy_days: null }),
        headers: { "Content-Type": "application/json" },
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { updated: boolean; retention_policy_days: null };
    expect(body.updated).toBe(true);
    expect(body.retention_policy_days).toBeNull();
  });
});
