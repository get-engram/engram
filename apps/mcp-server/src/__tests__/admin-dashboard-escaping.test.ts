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

  it("every runtime-built data-id / data-org interpolates a validated id and nothing else", () => {
    // Controls carry ids in data attributes and are dispatched by one
    // delegated listener (engram#514); there are no inline handlers left.
    expect(script).not.toMatch(/\son(?:click|change)=/);

    const built = [...script.matchAll(/data-(?:id|org)="' \+ (.+?) \+ '"/g)].map((m) => m[1]);
    // tierSelect, four per-user buttons, revoke (org + key), sync-from-Stripe.
    expect(built.length).toBeGreaterThanOrEqual(8);
    for (const seg of built) {
      expect(seg, seg).not.toContain("esc(");
      expect(seg, seg).toMatch(/^idAttr\([A-Za-z_][\w.]*\)$/);
    }
    // ...and no data-id / data-org is built any other way.
    expect([...script.matchAll(/data-(?:id|org)="/g)]).toHaveLength(built.length);
  });
});
