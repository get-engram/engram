import { Hono } from "hono";
import { cors } from "hono/cors";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authMiddleware } from "./middleware/auth.js";
import { createMcpServer } from "./mcp/server.js";
import { keys } from "./routes/keys.js";
import { seats } from "./routes/seats.js";
import { webhooks } from "./routes/webhooks.js";
import { usage } from "./routes/usage.js";
import { signup } from "./routes/signup.js";
import { billing, billingWebhook } from "./routes/billing.js";
import { admin } from "./routes/admin.js";
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

// MCP endpoint — all methods
app.all("/mcp", authMiddleware, async (c) => {
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
    allowHeaders: ["Content-Type"],
  }),
);
app.route("/signup", signup);

// Stripe webhook — public, verified by HMAC signature instead of API key.
// Mounted BEFORE the /api/* auth middleware so it isn't gated.
app.route("/billing/webhook", billingWebhook);

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
app.route("/api/keys", keys);
app.route("/api/seats", seats);
app.route("/api/webhooks", webhooks);
app.route("/api/usage", usage);
app.route("/api/billing", billing);

export default app;
