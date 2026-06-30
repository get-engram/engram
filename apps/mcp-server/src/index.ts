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
import { account } from "./routes/account.js";
import { dataExport } from "./routes/export.js";
import { purgeDeletedOrganizations } from "./cron/purge-deleted.js";
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

// OAuth authorization server endpoints (register, authorize, token).
app.route("/oauth", oauth);

// MCP endpoint — all methods
app.all("/mcp", authMiddleware, rateLimitMiddleware, async (c) => {
  const auth = c.get("auth");
  const server = createMcpServer(c.env, auth);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  await server.connect(transport);

  return transport.handleRequest(c.req.raw);
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

// Admin routes — protected by ADMIN_SECRET, not API key auth.
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
app.route("/api/export", dataExport);

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    const purged = await purgeDeletedOrganizations(env);
    if (purged > 0) {
      console.log(`[cron] Purged ${purged} expired organization(s)`);
    }
  },
};
