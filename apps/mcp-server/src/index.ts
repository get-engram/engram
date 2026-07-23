import { Hono } from "hono";
import { cors } from "hono/cors";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authMiddleware } from "./middleware/auth.js";
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
import { createMcpServer } from "./mcp/server.js";
import { keys } from "./routes/keys.js";
import { seats } from "./routes/seats.js";
import { webhooks } from "./routes/webhooks.js";
import { usage } from "./routes/usage.js";
import { signup } from "./routes/signup.js";
import { billing, billingSession, billingWebhook } from "./routes/billing.js";
import { admin } from "./routes/admin.js";
import { dashboardHtml } from "./routes/admin-dashboard.js";
import { account } from "./routes/account.js";
import { privacy } from "./routes/privacy.js";
import { dataExport } from "./routes/export.js";
import { oauthConnections } from "./routes/oauth-connections.js";
import { memories } from "./routes/memories.js";
import { invites } from "./routes/invites.js";
import { v1 } from "./routes/v1.js";
import { meterApiRequest } from "./middleware/meter.js";
import { purgeDeletedOrganizations } from "./cron/purge-deleted.js";
import { expireGracePeriods } from "./cron/expire-grace.js";
import { enforceRetentionPolicies } from "./cron/retention-policy.js";
import { sendImportNudges } from "./cron/import-nudge.js";
import { sendWeeklyDigests } from "./cron/weekly-digest.js";
import { sendDailyReport } from "./services/daily-report.js";
import { oauth } from "./oauth/router.js";
import {
  originOf,
  protectedResourceMetadata,
  authorizationServerMetadata,
} from "./oauth/metadata.js";
import type { Env, AuthContext } from "./types.js";

type HonoEnv = {
  Bindings: Env;
  Variables: { auth: AuthContext };
};

const app = new Hono<HonoEnv>();

// Global error handler — catches any uncaught exception and returns a
// structured 500 instead of letting Cloudflare surface `scriptThrewException`.
app.onError((err, c) => {
  console.error(`[error] ${c.req.method} ${c.req.path}: ${err.message}`);
  return c.json(
    { error: "internal_error", message: err.message },
    500,
  );
});

// Health check
app.get("/health", (c) => {
  return c.json({ status: "ok", service: "engram-mcp-server", version: "0.2.0" });
});

// OAuth 2.1 discovery (RFC 9728 / RFC 8414) — public, enable MCP clients like
// ChatGPT and Claude to auto-discover and connect via OAuth.
app.get("/.well-known/oauth-protected-resource", (c) =>
  c.json(protectedResourceMetadata(originOf(c.req.url))),
);
app.get("/.well-known/oauth-authorization-server", (c) =>
  c.json(authorizationServerMetadata(originOf(c.req.url))),
);

// OpenAI App Directory domain-ownership verification. Serves the challenge
// token (a public proof, not a secret) at the well-known path OpenAI checks.
const OPENAI_APPS_CHALLENGE_TOKEN = "wcJv6LrYXHjM7WuahvvnVsS-MHiXsf198fF43dpFkB8";
app.get("/.well-known/openai-apps-challenge", (c) =>
  c.text(OPENAI_APPS_CHALLENGE_TOKEN),
);

// OAuth authorization server endpoints (register, authorize, token).
app.route("/oauth", oauth);

// MCP endpoint — POST only for stateless transport. GET (SSE listen) and
// DELETE (session teardown) are not supported without server-side sessions.
// Returning 405 immediately prevents Cloudflare from killing the request as
// "hung" (scriptThrewException) when clients like Claude Code poll with GET.
app.get("/mcp", (c) =>
  c.json({ error: "method_not_allowed", message: "This server is stateless. Use POST for MCP requests." }, 405),
);
app.delete("/mcp", (c) =>
  c.json({ error: "method_not_allowed", message: "This server is stateless. Session deletion is not supported." }, 405),
);
app.post("/mcp", authMiddleware, rateLimitMiddleware, meterApiRequest, async (c) => {
  const auth = c.get("auth");
  const server = createMcpServer(c.env, auth);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(c.req.raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[mcp] transport error: ${msg}`);
    return c.json({ error: "mcp_error", message: msg }, 500);
  }
});

// CORS for browser-originated calls from the marketing site + dashboard.
// /signup and /api/* both need this; the Stripe webhook does not (it's
// called by Stripe's servers, not a browser).
const BROWSER_ORIGINS = [
  "https://getengram.app",
  "https://www.getengram.app",
  "http://localhost:3000",
];

app.use(
  "/signup",
  cors({
    origin: BROWSER_ORIGINS,
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);
app.route("/signup", signup);

// One-click digest unsubscribe (engram#256) — signed link from the
// weekly email; no login required. GET so it works from any mail client.
app.get("/email/unsubscribe", async (c) => {
  const org = c.req.query("org") ?? "";
  const sig = c.req.query("sig") ?? "";
  const secret = (c.env as Env & { ADMIN_SECRET?: string }).ADMIN_SECRET;
  if (!org || !sig || !secret) return c.text("Invalid link.", 400);
  const { unsubscribeSig } = await import("./cron/weekly-digest.js");
  const expected = await unsubscribeSig(org, secret);
  if (sig !== expected) return c.text("Invalid link.", 400);
  await c.env.DB.prepare("UPDATE organizations SET digest_opt_out = 1 WHERE id = ?")
    .bind(org)
    .run();
  return c.html(
    "<!doctype html><meta charset=utf-8><title>Unsubscribed</title><body style=\"font-family:sans-serif;max-width:32rem;margin:4rem auto;color:#27272a\"><h1 style=\"font-size:1.4rem\">You're unsubscribed</h1><p>No more weekly digest emails. Account and security emails still arrive when needed.</p><p><a href=\"https://getengram.app\">getengram.app</a></p>",
  );
});

// Team invite accept flow (engram#263) — public routes keyed by an
// unguessable single-use token; POST verifies the invitee's Supabase JWT.
app.use(
  "/invites/*",
  cors({
    origin: BROWSER_ORIGINS,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);
app.route("/invites", invites);

// Stripe webhook — public, verified by HMAC signature instead of API key.
// Mounted BEFORE the /api/* auth middleware so it isn't gated.
app.route("/billing/webhook", billingWebhook);

// Public session verification — lets the upgrade success page look up the
// org after a Stripe checkout without needing an API key.
app.use(
  "/billing/verify-session",
  cors({
    origin: BROWSER_ORIGINS,
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  }),
);
app.route("/billing/verify-session", billingSession);

// Admin dashboard — serves SPA HTML (auth handled client-side via sessionStorage).
app.get("/admin", (c) => c.html(dashboardHtml));

// Admin API routes — protected by ADMIN_SECRET, not API key auth.
app.use(
  "/admin/*",
  cors({
    origin: BROWSER_ORIGINS,
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  }),
);
app.use("/admin/*", async (c, next) => {
  const auth = c.req.header("Authorization");
  const secret = (c.env as Env & { ADMIN_SECRET: string }).ADMIN_SECRET;
  if (!secret || auth !== `Bearer ${secret}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});
app.route("/admin", admin);

// REST API routes (all require auth). CORS runs before the auth middleware
// so preflight OPTIONS requests succeed without a bearer token.
app.use(
  "/api/*",
  cors({
    origin: BROWSER_ORIGINS,
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  }),
);
app.use("/api/*", authMiddleware);

// Billing routes are exempt from rate limiting — never block someone trying to pay.
app.route("/api/billing", billing);

app.use("/api/*", rateLimitMiddleware);
app.route("/api/keys", keys);
app.route("/api/seats", seats);
app.route("/api/webhooks", webhooks);
app.route("/api/usage", usage);
app.route("/api/account", account);
app.route("/api/privacy", privacy);
app.route("/api/export", dataExport);
app.route("/api/oauth/connections", oauthConnections);
app.route("/api/memories", memories);

// Public REST API (engram#287) — the six MCP memory tools as REST
// endpoints, metered as API usage.
app.use("/api/v1/*", meterApiRequest);
app.route("/api/v1", v1);

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    // Two daily crons (see wrangler.toml [triggers]):
    //   03:00 UTC — GDPR purge of soft-deleted orgs
    //   13:00 UTC — daily ops report, emailed via engram-web
    if (event.cron === "0 13 * * *") {
      await sendDailyReport(env);
      // Weekly memory digest (engram#256) — Mondays only.
      if (new Date(event.scheduledTime).getUTCDay() === 1) {
        const digests = await sendWeeklyDigests(env);
        if (digests > 0) console.log(`[cron] Sent ${digests} weekly digest(s)`);
      }
      return;
    }
    const purged = await purgeDeletedOrganizations(env);
    if (purged > 0) {
      console.log(`[cron] Purged ${purged} expired organization(s)`);
    }
    const graceExpired = await expireGracePeriods(env);
    if (graceExpired > 0) {
      console.log(`[cron] Expired ${graceExpired} grace period(s)`);
    }
    // Enterprise custom-retention policies (engram#289) — no-op unless an
    // admin has explicitly set retention_policy_days on an org.
    const retentionDeleted = await enforceRetentionPolicies(env);
    if (retentionDeleted > 0) {
      console.log(`[cron] Retention policy deleted ${retentionDeleted} conversation(s)`);
    }
    // Import-first onboarding (engram#253): one nudge email per org that
    // signed up yesterday and hasn't stored anything yet.
    const nudged = await sendImportNudges(env);
    if (nudged > 0) {
      console.log(`[cron] Sent ${nudged} import-nudge email(s)`);
    }
  },
};
