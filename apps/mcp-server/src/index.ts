import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authMiddleware } from "./middleware/auth.js";
import { createMcpServer } from "./mcp/server.js";
import type { Env, AuthContext } from "./types.js";

type HonoEnv = {
  Bindings: Env;
  Variables: { auth: AuthContext };
};

const app = new Hono<HonoEnv>();

// Health check
app.get("/health", (c) => {
  return c.json({ status: "ok", service: "engram-mcp-server", version: "0.1.0" });
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

export default app;
