import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import app from "../index.js";
import { createMockD1, createMockEnv } from "./helpers.js";
import { adminConsoleSecurityPolicy, dashboardHtml } from "../routes/admin-dashboard.js";
import {
  HTML_CONTENT_SECURITY_POLICY,
  cspSha256,
  inlineHashSources,
} from "../middleware/security-headers.js";

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext;

function between(html: string, open: string, close: string): string {
  const start = html.indexOf(open);
  const end = html.indexOf(close, start);
  if (start < 0 || end < 0) throw new Error(`${open} block not found`);
  return html.slice(start + open.length, end);
}

// The exact served bytes between the tags — what a browser hashes.
const script = between(dashboardHtml, "<script>", "</script>");
const style = between(dashboardHtml, "<style>", "</style>");

// Independent of the worker's WebCrypto path.
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("base64");

function directives(csp: string): Record<string, string[]> {
  return Object.fromEntries(
    csp.split(";").map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name, values];
    }),
  );
}

describe("admin console CSP (engram#514)", () => {
  it("allows the inline script and style by hash and nothing by 'unsafe-inline'", async () => {
    const csp = await adminConsoleSecurityPolicy();
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("'unsafe-hashes'");
    const d = directives(csp);
    expect(d["script-src"]).toEqual([`'sha256-${sha256(script)}'`]);
    expect(d["style-src"]).toEqual([`'sha256-${sha256(style)}'`]);
    expect(d["default-src"]).toEqual(["'none'"]);
    expect(d["connect-src"]).toEqual(["'self'"]);
    expect(d["img-src"]).toEqual(["'self'", "data:"]);
    expect(d["base-uri"]).toEqual(["'none'"]);
    expect(d["form-action"]).toEqual(["'none'"]);
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
  });

  it("serves GET /admin with that policy, and the hashed bytes are the served bytes", async () => {
    const env = { ...createMockEnv(createMockD1()), ADMIN_SECRET: "test-admin-secret-for-csp" };
    const res = await app.fetch(new Request("http://localhost/admin"), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type") ?? "").toMatch(/^text\/html/);
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toBe(await adminConsoleSecurityPolicy());
    expect(csp).not.toBe(HTML_CONTENT_SECURITY_POLICY);
    expect(await res.text()).toBe(dashboardHtml);
    // Still covered by the blanket headers; the console holds an admin session.
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("the page has exactly one bare <script> and one bare <style>, so the hashes cover everything", () => {
    expect(dashboardHtml.match(/<script\b/gi)).toHaveLength(1);
    expect(dashboardHtml.match(/<style\b/gi)).toHaveLength(1);
    expect(dashboardHtml).toContain("<script>");
    expect(dashboardHtml).toContain("<style>");
  });

  it("has no inline event handler, in markup or in HTML built at runtime", () => {
    // A hash allows the <script> block only; an on*= attribute is refused.
    expect(dashboardHtml.match(/\son[a-z]+\s*=/gi) ?? []).toEqual([]);
    expect(dashboardHtml).not.toContain("javascript:");
  });

  it("has no style attribute, in markup or in HTML built at runtime", () => {
    // Same for style=: the <style> block is hashed, attributes are refused.
    // CSSOM writes (el.style.display = ...) are not subject to CSP and stay.
    expect(dashboardHtml.match(/\sstyle\s*=\s*["'\\]/g) ?? []).toEqual([]);
    expect(dashboardHtml).not.toContain("setAttribute('style'");
    expect(dashboardHtml).not.toContain("cssText");
  });

  it("every data-action in the page is in the ACTIONS table, and every entry is used", () => {
    const table = script.match(/const ACTIONS = \{([\s\S]*?)\n\};/);
    expect(table).not.toBeNull();
    const known = new Set([...(table?.[1] ?? "").matchAll(/^\s*'([a-z-]+)':/gm)].map((m) => m[1]));
    const used = [...dashboardHtml.matchAll(/data-action="([^"]*)"/g)].map((m) => m[1]);
    // login, refresh, logout, prev/next page, load audit/keys, close modal,
    // stripe, delete, audit, keys, sync-stripe, revoke.
    expect(used.length).toBeGreaterThanOrEqual(14);
    for (const action of used) expect(known.has(action), `data-action="${action}"`).toBe(true);
    for (const action of known) expect(used, `ACTIONS['${action}']`).toContain(action);
  });

  it("inlineHashSources hashes every bare block and refuses what it cannot hash", async () => {
    expect(await inlineHashSources("<style>a{}</style><p/><style>b{}</style>", "style")).toBe(
      `${await cspSha256("a{}")} ${await cspSha256("b{}")}`,
    );
    // A tag with attributes would be served unhashed and refused by the browser.
    await expect(inlineHashSources('<script type="module">x</script>', "script")).rejects.toThrow(/bare/);
    await expect(inlineHashSources("<script>a</script><SCRIPT>b</SCRIPT>", "script")).rejects.toThrow(/bare/);
    // No block at all: the wrong template was passed.
    await expect(inlineHashSources("<p>no script</p>", "script")).rejects.toThrow(/bare/);
  });

  it("cspSha256 is the CSP form: base64 of the SHA-256 of the UTF-8 text, untrimmed", async () => {
    expect(await cspSha256("alert(1)")).toBe(`'sha256-${sha256("alert(1)")}'`);
    expect(await cspSha256("\n  é ✓ \n")).toBe(`'sha256-${sha256("\n  é ✓ \n")}'`);
    expect(await cspSha256("x")).not.toBe(await cspSha256(" x"));
  });
});
