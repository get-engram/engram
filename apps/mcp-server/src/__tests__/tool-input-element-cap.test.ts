import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MAX_MESSAGES_PER_APPEND } from "@getengram/shared";
import { createMockD1, createMockEnv } from "./helpers.js";
import { createMcpServer, MAX_TOOL_INPUT_ELEMENTS } from "../mcp/server.js";
import type { Env, AuthContext } from "../types.js";

/**
 * tools/call element cap. The Worker's 8 MB body limit bounds bytes, not
 * shape: 8 MB of JSON can carry ~4 million array elements or object members,
 * and validating a payload that size is a CPU-time sink. Since 1.32 the MCP
 * SDK counts the elements of the arguments object before schema validation
 * and refuses the call above a configured ceiling. These tests go through a
 * real McpServer over an in-memory transport, so they pin what a client
 * actually gets back, not what a shim records.
 */

type CallResult = { isError?: boolean; content?: unknown; structuredContent?: unknown };

async function connectedClient() {
  const env = createMockEnv(createMockD1()) as unknown as Env;
  const auth: AuthContext = {
    organizationId: "org_cap",
    apiKeyId: "key_cap",
    tier: "pro",
    scopes: ["read", "write", "search", "delete"],
  };
  const server = createMcpServer(env, auth);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "element-cap-test", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

function resultText(res: CallResult): string {
  return JSON.stringify(res.content ?? "");
}

describe("tools/call element cap", () => {
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;

  beforeAll(async () => {
    ({ client, server } = await connectedClient());
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it("is sized from the append batch limit", () => {
    expect(MAX_TOOL_INPUT_ELEMENTS).toBe(MAX_MESSAGES_PER_APPEND * 500);
    expect(MAX_TOOL_INPUT_ELEMENTS).toBeGreaterThanOrEqual(100_000);
  });

  it("refuses a schema-valid append whose metadata bags push the payload over the cap", async () => {
    // 200 messages x (3 members + a 501-element metadata bag) ~ 101k
    // elements. Each bag serialises to ~1 KB, so this passes the 16k-char
    // metadata rule and the 200-message rule; only the element ceiling
    // stands between it and the handler.
    const bag = { blob: new Array(500).fill(0) };
    const messages = Array.from({ length: MAX_MESSAGES_PER_APPEND }, () => ({
      role: "user",
      content: "x",
      metadata: bag,
    }));
    const res = (await client.callTool({
      name: "append_messages",
      arguments: { messages },
    })) as CallResult;
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain(
      `more than the maximum of ${MAX_TOOL_INPUT_ELEMENTS} elements`,
    );
  });

  it("admits a full-size daemon batch: 200 messages with tools_used metadata", async () => {
    const messages = Array.from({ length: MAX_MESSAGES_PER_APPEND }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: `message ${i}`,
      metadata: { tools_used: Array.from({ length: 20 }, (_, j) => `tool_${j}`) },
    }));
    const res = (await client.callTool({
      name: "append_messages",
      arguments: { messages },
    })) as CallResult;
    // The call must reach the handler. Both the element cap and a Zod
    // failure come back from the SDK as "Invalid arguments for tool ...";
    // what the handler returns against the mock D1 (a storage-usage error)
    // is a different sentence.
    expect(resultText(res)).not.toContain("more than the maximum");
    expect(resultText(res)).not.toContain("Invalid arguments");
  });
});
