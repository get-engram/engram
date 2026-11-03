import { createMiddleware } from "hono/factory";

/**
 * Response hardening headers (engram#459).
 *
 * The worker is an API with three HTML-ish surfaces: the admin console at
 * /admin, the one-click unsubscribe page, and (as an image) the open-tracking
 * pixel. None of them sent a single hardening header, so the admin console —
 * which keeps ADMIN_SECRET in sessionStorage — could be framed from any
 * origin for UI redress.
 *
 * Applied to EVERY response, not only HTML. The JSON API gains nothing from
 * framing or sniffing protection, but a blanket rule has no gaps: a new HTML
 * route is covered the day it is written, and onError's 500s are covered too.
 *
 * - X-Frame-Options: DENY and frame-ancestors 'none': nothing here is ever
 *   embedded (the web app does not iframe the worker).
 * - X-Content-Type-Options: nosniff: a body is never sniffed into a script
 *   or a page it was not declared to be.
 * - Referrer-Policy: no-referrer: the unsubscribe URL carries a signed
 *   token; a link off that page must not leak it in a Referer.
 * - Strict-Transport-Security: the host is HTTPS-only behind Cloudflare; the
 *   header makes a browser refuse plain HTTP for it from then on.
 *
 * HTML additionally gets a Content-Security-Policy and Cache-Control:
 * no-store. The shared HTML policy loads nothing from anywhere (default-src
 * 'none'), runs no script at all (no script-src, so scripts fall to
 * default-src 'none'), lets the page talk only to its own origin, and forbids
 * framing, form submission and base-URL rewriting. style-src 'unsafe-inline'
 * remains for the unsubscribe page: a one-line template with a couple of
 * fixed style attributes and nothing dynamic inside them. The admin console,
 * the one page that does run script, sets its own policy that allows its
 * inline <script> and <style> by hash (adminConsoleSecurityPolicy,
 * engram#514), so 'unsafe-inline' for script is gone everywhere.
 *
 * A header a route set itself wins (set-if-absent), so the pixel keeps its
 * own Cache-Control and the console keeps its own CSP.
 */
export const BASE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Permitted-Cross-Domain-Policies": "none",
};

export const HTML_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export const securityHeaders = createMiddleware(async (c, next) => {
  await next();

  let headers = c.res.headers;
  try {
    headers.set("X-Content-Type-Options", headers.get("X-Content-Type-Options") ?? "nosniff");
  } catch {
    // A Response handed straight back from fetch() has immutable headers.
    // No route does that today; if one ever does, re-wrap rather than 500.
    c.res = new Response(c.res.body, c.res);
    headers = c.res.headers;
  }

  for (const [name, value] of Object.entries(BASE_SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }

  if (/^text\/html\b/i.test(headers.get("Content-Type") ?? "")) {
    if (!headers.has("Content-Security-Policy")) {
      headers.set("Content-Security-Policy", HTML_CONTENT_SECURITY_POLICY);
    }
    if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  }
});

/**
 * A CSP hash source for one inline block: 'sha256-<base64>' over the UTF-8
 * bytes of exactly the text between the tags, which is what the browser
 * hashes (CSP3 §6.7.2.1). Not a single byte may be trimmed or re-encoded.
 */
export async function cspSha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`;
}

/**
 * Hash sources for every inline <tag>…</tag> block in a document, joined for
 * a script-src or style-src directive, so the blocks can be allowed without
 * 'unsafe-inline'.
 *
 * Strict by design: only bare `<script>` / `<style>` opening tags are hashed.
 * A tag with attributes would be served but not allowed — the browser would
 * refuse it and the page would break quietly — so that is an error here, as
 * is a document with no block at all (a sign the wrong template was passed).
 */
export async function inlineHashSources(html: string, tag: "script" | "style"): Promise<string> {
  const opening = html.match(new RegExp(`<${tag}\\b`, "gi"))?.length ?? 0;
  const blocks = [...html.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]);
  if (blocks.length === 0 || blocks.length !== opening) {
    throw new Error(
      `inlineHashSources: only bare <${tag}> blocks can be hashed (found ${opening} <${tag} tag(s), ${blocks.length} hashable)`,
    );
  }
  return (await Promise.all(blocks.map(cspSha256))).join(" ");
}
