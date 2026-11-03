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
 * no-store. The CSP is as tight as the admin console allows today: no
 * script, style, font or image loads from anywhere (default-src 'none'),
 * the page may only talk to its own origin (connect-src 'self'), may not be
 * framed, may not submit a form anywhere, and may not have its base URL
 * rewritten. 'unsafe-inline' for script-src is the known gap — the console
 * is one inline <script> plus onclick= attributes built at runtime; moving
 * to a hashed script and delegated handlers is the follow-up that closes
 * it (engram#514).
 *
 * A header a route set itself wins (set-if-absent), so the pixel keeps its
 * own Cache-Control and a future route can tighten its CSP further.
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
  "script-src 'unsafe-inline'",
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
