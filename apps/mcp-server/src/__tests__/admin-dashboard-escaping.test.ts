import { describe, it, expect } from "vitest";
import { dashboardHtml } from "../routes/admin-dashboard.js";

// Pulls a top-level function out of the served page's inline script and
// evaluates it, so the assertions run the exact code an operator's browser
// runs rather than a copy that could drift.
function pageFunction(name: string): (...args: unknown[]) => unknown {
  const m = dashboardHtml.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  if (!m) throw new Error(`${name}() not found in the dashboard script`);
  return new Function(`${m[0]}\nreturn ${name};`)() as (...args: unknown[]) => unknown;
}

const script = dashboardHtml.slice(
  dashboardHtml.indexOf("<script>"),
  dashboardHtml.indexOf("</script>"),
);

describe("admin console escaping (engram#512)", () => {
  const esc = pageFunction("esc");
  const idAttr = pageFunction("idAttr");

  it("esc() escapes both quote characters as well as the angle brackets and ampersand", () => {
    expect(esc('<a href="x" onmouseover=\'y\'>&')).toBe(
      "&lt;a href=&quot;x&quot; onmouseover=&#39;y&#39;&gt;&amp;",
    );
    expect(esc("plain text")).toBe("plain text");
    expect(esc(42)).toBe("42");
  });

  it("the inline script parses (a broken console would otherwise ship silently)", () => {
    const body = script.slice("<script>".length);
    expect(() => new Function(body)).not.toThrow();
  });

  it("esc() keeps the muted placeholder for a missing value", () => {
    expect(esc(null)).toContain("-</span>");
    expect(esc(undefined)).toBe(esc(null));
  });

  it("idAttr() passes server-minted ids and nothing else", () => {
    expect(idAttr("org_Ab12-xy_Z")).toBe("org_Ab12-xy_Z");
    expect(idAttr("key_abcdefghijklmnop")).toBe("key_abcdefghijklmnop");
    expect(idAttr("org_x'); alert(1); ('")).toBe("");
    expect(idAttr('org_x" onmouseover="alert(1)')).toBe("");
    expect(idAttr("org_x\\'")).toBe("");
    expect(idAttr("")).toBe("");
    expect(idAttr(undefined)).toBe("");
    expect(idAttr(null)).toBe("");
    expect(idAttr(12345)).toBe("");
    expect(idAttr("a".repeat(65))).toBe("");
  });

  it("every dynamic inline handler interpolates a validated id and nothing else", () => {
    const handlers = [...script.matchAll(/on(?:click|change)="([^"]*)"/g)].map((m) => m[1]);
    // tierSelect, four per-user buttons, revoke, sync-from-Stripe, close.
    expect(handlers.length).toBeGreaterThanOrEqual(8);

    let dynamic = 0;
    for (const handler of handlers) {
      expect(handler, handler).not.toContain("esc(");
      for (const seg of handler.matchAll(/' \+ (.+?) \+ '/g)) {
        dynamic++;
        expect(seg[1], handler).toMatch(/^idAttr\([A-Za-z_][\w.]*\)$/);
      }
    }
    expect(dynamic).toBeGreaterThanOrEqual(8);
  });
});
