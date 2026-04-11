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

// Public signup endpoint (CORS for the marketing site)
app.use(
  "/signup",
  cors({
    origin: [
      "https://getengram.app",
      "https://www.getengram.app",
      "http://localhost:3000",
    ],
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  }),
);
app.route("/signup", signup);

// REST API routes (all require auth)
app.use("/api/*", authMiddleware);
app.route("/api/keys", keys);
app.route("/api/seats", seats);
app.route("/api/webhooks", webhooks);
app.route("/api/usage", usage);

export default app;
