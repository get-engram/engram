import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { admin } from "../routes/admin.js";
import { AUDIT_RETENTION_DAYS } from "../cron/audit-retention.js";
import { createMockD1, createMockEnv } from "./helpers.js";
import type { Env } from "../types.js";

type Call = { sql: string; bindings: unknown[] };

// Records every statement the route prepares, bound or not. A bind-level
// recorder would miss `DELETE FROM audit_log` precisely because an
// unfiltered delete binds nothing — and that statement is the one this
// file exists to prove is gone.
function recordPrepared(db: D1Database): Call[] {
  const calls: Call[] = [];
  const real = db.prepare.bind(db);
  (db as unknown as { prepare: (sql: string) => D1PreparedStatement }).prepare = (sql: string) => {
    const call: Call = { sql, bindings: [] };
    calls.push(call);
    const stmt = real(sql);
    const bind = stmt.bind.bind(stmt);
    stmt.bind = (...args: unknown[]) => {
      call.bindings = args;
      return bind(...args);
    };
    return stmt;
  };
  return calls;
}

function setup() {
  const db = createMockD1();
  const calls = recordPrepared(db);
  const env = createMockEnv(db) as unknown as Env;
  const app = new Hono<{ Bindings: Env }>();
  app.route("/admin", admin);
  return { app, env, calls };
}

const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /admin/reclaim-space", () => {
  it("never issues an unfiltered DELETE FROM audit_log", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { app, env, calls } = setup();
    const res = await app.request("/admin/reclaim-space", { method: "POST" }, env);
    expect(res.status).toBe(200);
    expect(calls.filter((c) => /^DELETE FROM audit_log$/i.test(norm(c.sql)))).toEqual([]);
  });

  it("runs the same bounded retention job the nightly cron runs", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { app, env, calls } = setup();
    const res = await app.request("/admin/reclaim-space", { method: "POST" }, env);

    const audit = calls.filter((c) => /DELETE FROM audit_log/i.test(c.sql));
    expect(audit.length).toBeGreaterThan(0);
    for (const c of audit) {
      expect(norm(c.sql)).toMatch(
        /^DELETE FROM audit_log WHERE id IN \( SELECT id FROM audit_log WHERE created_at < datetime\('now', \?\) LIMIT 500 \)$/,
      );
      expect(c.bindings).toEqual([`-${AUDIT_RETENTION_DAYS} days`]);
    }

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      reclaimed: true,
      scope: "logs",
      audit_log_deleted: 0,
      audit_log_retention_days: AUDIT_RETENTION_DAYS,
    });
    expect(body.audit_log_error).toBeUndefined();
  });

  it("still trims email_log to the last 7 days", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { app, env, calls } = setup();
    await app.request("/admin/reclaim-space", { method: "POST" }, env);
    expect(
      calls.some((c) => norm(c.sql) === "DELETE FROM email_log WHERE sent_at < datetime('now','-7 days')"),
    ).toBe(true);
  });

  it("scope=fts additionally resets the FTS index", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { app, env, calls } = setup();
    const res = await app.request("/admin/reclaim-space?scope=fts", { method: "POST" }, env);
    expect(res.status).toBe(200);
    expect(calls.some((c) => norm(c.sql) === "UPDATE conversation_chunks SET fts_rowid = NULL")).toBe(true);
    expect(calls.some((c) => norm(c.sql) === "DELETE FROM chunks_fts_v2")).toBe(true);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.scope).toBe("fts");
  });

  it("writes one operator log line with the result", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { app, env } = setup();
    await app.request("/admin/reclaim-space", { method: "POST" }, env);
    const line = log.mock.calls
      .map((args) => args.join(" "))
      .find((l) => l.startsWith("[admin] reclaim-space"));
    expect(line).toBeDefined();
    expect(line).toContain('"audit_log_deleted":0');
  });
});
