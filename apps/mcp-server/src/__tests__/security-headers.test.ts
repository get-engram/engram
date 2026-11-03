import { describe, it, expect } from "vitest";
import app from "../index.js";
import { createMockD1, createMockEnv } from "./helpers.js";
import { unsubscribeSig } from "../cron/weekly-digest.js";
import {
  BASE_SECURITY_HEADERS,
  HTML_CONTENT_SECURITY_POLICY,
} from "../middleware/security-headers.js";
import { adminConsoleSecurityPolicy } from "../routes/admin-dashboard.js";

const ADMIN_SECRET = "test-admin-secret-for-headers";
const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext;

function makeEnv() {
  return { ...createMockEnv(createMockD1()), ADMIN_SECRET };
}

function get(path: string) {
  return app.fetch(new Request(`http://localhost${path}`), makeEnv(), ctx);
}

function expectBaseHeaders(res: Response) {
  for (const [name, value] of Object.entries(BASE_SECURITY_HEADERS)) {
    expect(res.headers.get(name), name).toBe(value);
  }
}

describe("response hardening headers (engram#459)", () => {
  it("serves the admin console with its own hash-based policy (engram#514)", async () => {
    const res = await get("/admin");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type") ?? "").toMatch(/^text\/html/);
    expectBaseHeaders(res);
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toBe(await adminConsoleSecurityPolicy());
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/]+=*'/);
    for (const directive of [
      "default-src 'none'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ]) {
      expect(csp).toContain(directive);
    }
    // The page holds an admin session; a browser must not keep a copy.
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("covers a rejected unsubscribe link (a 4xx from a route)", async () => {
    const res = await get("/email/unsubscribe");
    expect(res.status).toBe(400);
    expectBaseHeaders(res);
    // text/plain: no CSP applies, and none is promised.
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });

  it("gives the unsubscribe confirmation page the HTML policy", async () => {
    const org = "org_headers_test";
    const sig = await unsubscribeSig(org, ADMIN_SECRET);
    const res = await get(`/email/unsubscribe?org=${org}&sig=${sig}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type") ?? "").toMatch(/^text\/html/);
    expectBaseHeaders(res);
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toBe(HTML_CONTENT_SECURITY_POLICY);
    // A static page: no script of any kind (no script-src, so default-src
    // 'none' governs), and never 'unsafe-inline' for script anywhere.
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("script-src");
    // The URL carries the signed token; a click off this page must not leak it.
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("lets the tracking pixel keep its own Cache-Control (set-if-absent)", async () => {
    const res = await get("/email/open?id=not-a-real-id");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/gif");
    expect(res.headers.get("Cache-Control")).toBe("no-store, max-age=0");
    expectBaseHeaders(res);
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });

  it("adds the base headers to JSON without a CSP", async () => {
    const res = await get("/health");
    expect(res.status).toBe(200);
    expectBaseHeaders(res);
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });

  it("covers the router's own 404", async () => {
    const res = await get("/definitely-not-a-route");
    expect(res.status).toBe(404);
    expectBaseHeaders(res);
  });
});
