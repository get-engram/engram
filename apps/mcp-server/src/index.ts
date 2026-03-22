import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  await server.connect(transport);

  const request = c.req.raw;
  const response = await transport.handleRequest(request);

  // StreamableHTTPServerTransport.handleRequest returns a Response or undefined
  if (response) {
    return response;
  }

  return c.json({ error: "No response from MCP transport" }, 500);
});

export default app;
