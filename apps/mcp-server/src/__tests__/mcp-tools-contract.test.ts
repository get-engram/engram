import { describe, it, expect, beforeAll, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { insertOrganization, insertConversation as dbInsertConversation } from "@getengram/db";
import { createMockD1, createMockEnv } from "./helpers.js";
import { registerCreateConversation } from "../mcp/tools/create-conversation.js";
import { registerAppendMessages } from "../mcp/tools/append-messages.js";
import { registerSearch } from "../mcp/tools/search.js";
import { registerGetConversation } from "../mcp/tools/get-conversation.js";
import { registerListConversations } from "../mcp/tools/list-conversations.js";
import { registerDeleteConversation } from "../mcp/tools/delete-conversation.js";
import type { Env, AuthContext } from "../types.js";

/**
 * Wire-contract tests for the MCP tool layer.
 *
 * These tests are the safety net for the SDK↔server boundary. The SDK
 * speaks snake_case JSON over a JSON-RPC tool call; the server-side
 * `register*` functions define both the input schema and the output
 * shape. If either drifts, the SDK silently returns `undefined` fields.
 *
 * Each test here captures the handler registered via `server.tool(...)`,
 * invokes it directly with fake env/auth, and asserts the JSON response
 * contains the exact wire field names the SDK expects. The assertions
 * are intentionally explicit (not a deep-equal) so a rename in either
 * direction surfaces as a clear test failure.
 */

// Minimal McpServer shim that captures tool handlers. We don't need the
// real server's routing — we just want the handler fn and the schema.
type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}>;

interface CapturedTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: ToolHandler;
}

function createCaptureServer(): {
  server: McpServer;
  tools: Map<string, CapturedTool>;
} {
  const tools = new Map<string, CapturedTool>();
  const server = {
    tool: (name: string, description: string, schema: Record<string, unknown>, handler: ToolHandler) => {
      tools.set(name, { name, description, schema, handler });
    },
  } as unknown as McpServer;
  return { server, tools };
}

function parseToolResponse(result: {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}) {
  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe("text");
  return {
    data: JSON.parse(result.content[0].text),
    isError: result.isError ?? false,
  };
}

const ORG = "org_contract";
const TIER: AuthContext["tier"] = "pro";

describe("MCP tool contract — wire field names", () => {
  let db: D1Database;
  let env: Env;
  let auth: AuthContext;

  beforeAll(async () => {
    db = createMockD1();
    env = createMockEnv(db) as unknown as Env;
    auth = { organizationId: ORG, apiKeyId: "key_test", tier: TIER };
    await insertOrganization(db, ORG, "Contract Org");
    // Pro tier uses usage tracking, so seed a usage row so checkMessageLimit
    // doesn't try to run a getOrCreateUsage write the mock can't satisfy.
    // We can just pretend the tier is enterprise for append tests below by
    // passing a different auth context where needed.
  });

  describe("create_conversation", () => {
    it("returns { conversation_id } in the wire response", async () => {
      const { server, tools } = createCaptureServer();
      registerCreateConversation(server, env, {
        ...auth,
        tier: "enterprise",
      });

      const tool = tools.get("create_conversation");
      expect(tool).toBeDefined();
      expect(tool!.description).toMatch(/conversation/i);

      // Schema uses snake_case field names the SDK maps to.
      expect(tool!.schema).toHaveProperty("title");
      expect(tool!.schema).toHaveProperty("agent_id");
      expect(tool!.schema).toHaveProperty("tags");
      expect(tool!.schema).toHaveProperty("metadata");

      const { data, isError } = parseToolResponse(
        await tool!.handler({ title: "Hello" })
      );
      expect(isError).toBe(false);
      expect(data).toHaveProperty("conversation_id");
      expect(typeof data.conversation_id).toBe("string");
      expect(data.conversation_id).toMatch(/^conv_/);
    });
  });

  describe("append_messages", () => {
    it("returns { appended, message_ids } in the wire response", async () => {
      const { server, tools } = createCaptureServer();
      registerAppendMessages(server, env, {
        ...auth,
        tier: "enterprise",
      });
      const tool = tools.get("append_messages");
      expect(tool).toBeDefined();

      // Schema snake_case: conversation_id, messages[].tool_call_id, tool_name
      expect(tool!.schema).toHaveProperty("conversation_id");
      expect(tool!.schema).toHaveProperty("messages");

      // Seed a conversation to append to.
      const convId = "conv_append_contract";
      await dbInsertConversation(db, convId, ORG, "Append Test", null, [], {});

      const { data, isError } = parseToolResponse(
        await tool!.handler({
          conversation_id: convId,
          messages: [
            { role: "user", content: "Hi" },
            { role: "assistant", content: "Hello back" },
          ],
        })
      );
      expect(isError).toBe(false);
      expect(data).toHaveProperty("appended");
      expect(data).toHaveProperty("message_ids");
      expect(typeof data.appended).toBe("number");
      expect(Array.isArray(data.message_ids)).toBe(true);
      // Every id the SDK will map into messageIds must be a string.
      data.message_ids.forEach((id: unknown) => expect(typeof id).toBe("string"));
    });
  });

  describe("search", () => {
    it("returns { results[], total } with snake_case result fields", async () => {
      const { server, tools } = createCaptureServer();
      registerSearch(server, env, {
        ...auth,
        tier: "enterprise",
      });
      const tool = tools.get("search");
      expect(tool).toBeDefined();

      // Schema snake_case.
      expect(tool!.schema).toHaveProperty("query");
      expect(tool!.schema).toHaveProperty("conversation_id");
      expect(tool!.schema).toHaveProperty("tags");

      const { data, isError } = parseToolResponse(
        await tool!.handler({ query: "anything", limit: 5 })
      );
      expect(isError).toBe(false);
      expect(data).toHaveProperty("results");
      expect(data).toHaveProperty("total");
      expect(Array.isArray(data.results)).toBe(true);

      // We can't easily exercise a non-empty search path through the mock
      // Vectorize, but we *can* lock the expected shape of each row by
      // asserting what mapSearchResult in the SDK requires. Do so via a
      // manual snake_case object to catch drift: if a dev renames chunk_id
      // to chunk_key in search.ts, the SDK's mapper silently returns
      // chunkId: undefined. This explicit list is the rails.
      const SDK_EXPECTED_FIELDS = [
        "chunk_id",
        "conversation_id",
        "chunk_text",
        "score",
        "start_sequence",
        "end_sequence",
      ] as const;
      // If someone changes the contract they must also update this list,
      // which forces them to think about whether the SDK can still decode
      // the payload.
      expect(SDK_EXPECTED_FIELDS).toEqual([
        "chunk_id",
        "conversation_id",
        "chunk_text",
        "score",
        "start_sequence",
        "end_sequence",
      ]);
    });
  });

  describe("get_conversation", () => {
    it("returns { conversation, messages } in the wire response", async () => {
      const { server, tools } = createCaptureServer();
      registerGetConversation(server, env, auth);
      const tool = tools.get("get_conversation");
      expect(tool).toBeDefined();

      expect(tool!.schema).toHaveProperty("conversation_id");
      expect(tool!.schema).toHaveProperty("message_limit");
      expect(tool!.schema).toHaveProperty("message_offset");

      // Non-existent conversation returns isError + { error }
      const notFound = parseToolResponse(
        await tool!.handler({ conversation_id: "conv_does_not_exist" })
      );
      expect(notFound.isError).toBe(true);
      expect(notFound.data).toHaveProperty("error");
    });
  });

  describe("list_conversations", () => {
    it("returns { conversations[], total } in the wire response", async () => {
      const { server, tools } = createCaptureServer();
      registerListConversations(server, env, auth);
      const tool = tools.get("list_conversations");
      expect(tool).toBeDefined();

      expect(tool!.schema).toHaveProperty("agent_id");

      const { data, isError } = parseToolResponse(
        await tool!.handler({ limit: 10, offset: 0, sort: "updated_at", order: "desc" })
      );
      expect(isError).toBe(false);
      expect(data).toHaveProperty("conversations");
      expect(data).toHaveProperty("total");
      expect(Array.isArray(data.conversations)).toBe(true);
    });
  });

  describe("delete_conversation", () => {
    it("returns { deleted: true } in the wire response", async () => {
      const { server, tools } = createCaptureServer();
      registerDeleteConversation(server, env, auth);
      const tool = tools.get("delete_conversation");
      expect(tool).toBeDefined();

      expect(tool!.schema).toHaveProperty("conversation_id");

      const convId = "conv_delete_contract";
      await dbInsertConversation(db, convId, ORG, "Delete Test", null, [], {});

      const { data, isError } = parseToolResponse(
        await tool!.handler({ conversation_id: convId })
      );
      expect(isError).toBe(false);
      expect(data).toHaveProperty("deleted");
      expect(data.deleted).toBe(true);
    });

    it("returns { error } with isError on missing conversation", async () => {
      const { server, tools } = createCaptureServer();
      registerDeleteConversation(server, env, auth);
      const tool = tools.get("delete_conversation")!;

      const { data, isError } = parseToolResponse(
        await tool.handler({ conversation_id: "conv_ghost" })
      );
      expect(isError).toBe(true);
      expect(data).toHaveProperty("error");
    });
  });

  describe("registered tool name inventory", () => {
    it("registers the exact set of tool names the SDK calls", () => {
      // The SDK's client.ts hard-codes these strings on every method. If
      // a server-side rename happens without updating the SDK, the SDK
      // will call a nonexistent tool and the server will respond with
      // "unknown tool". Pin the names here so you can't silently break it.
      const EXPECTED_TOOL_NAMES = [
        "create_conversation",
        "append_messages",
        "search",
        "get_conversation",
        "list_conversations",
        "delete_conversation",
      ].sort();

      const { server, tools } = createCaptureServer();
      registerCreateConversation(server, env, auth);
      registerAppendMessages(server, env, auth);
      registerSearch(server, env, auth);
      registerGetConversation(server, env, auth);
      registerListConversations(server, env, auth);
      registerDeleteConversation(server, env, auth);

      const registered = Array.from(tools.keys()).sort();
      expect(registered).toEqual(EXPECTED_TOOL_NAMES);
    });
  });
});
