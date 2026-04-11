import { describe, it, expect, vi, beforeEach } from "vitest";
import { Engram } from "../client.js";
import { EngramError, AuthenticationError, TimeoutError } from "../errors.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function sseResponse(data: Record<string, unknown>, status = 200) {
  const jsonRpc = {
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{ type: "text", text: JSON.stringify(data) }],
    },
  };
  return {
    status,
    headers: new Headers(),
    text: () => Promise.resolve(`event: message\ndata: ${JSON.stringify(jsonRpc)}`),
  };
}

function errorResponse(message: string, status = 200) {
  const jsonRpc = {
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{ type: "text", text: message }],
      isError: true,
    },
  };
  return {
    status,
    headers: new Headers(),
    text: () => Promise.resolve(`event: message\ndata: ${JSON.stringify(jsonRpc)}`),
  };
}

describe("Engram SDK", () => {
  let engram: Engram;

  beforeEach(() => {
    vi.clearAllMocks();
    engram = new Engram({ apiKey: "engram_sk_live_test123" });
  });

  it("throws if apiKey is missing", () => {
    expect(() => new Engram({ apiKey: "" })).toThrow("apiKey is required");
  });

  it("uses default base URL", async () => {
    mockFetch.mockResolvedValueOnce(sseResponse({ conversation_id: "conv_abc" }));
    await engram.createConversation();

    expect(mockFetch).toHaveBeenCalledWith(
      "https://mcp.getengram.app/mcp",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer engram_sk_live_test123",
        }),
      }),
    );
  });

  it("uses custom base URL", async () => {
    const custom = new Engram({
      apiKey: "engram_sk_live_test",
      baseUrl: "http://localhost:8787",
    });
    mockFetch.mockResolvedValueOnce(sseResponse({ conversation_id: "conv_abc" }));
    await custom.createConversation();

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8787/mcp",
      expect.anything(),
    );
  });

  describe("createConversation", () => {
    it("creates a conversation with no params", async () => {
      mockFetch.mockResolvedValueOnce(sseResponse({ conversation_id: "conv_123" }));
      const result = await engram.createConversation();
      expect(result).toEqual({ conversationId: "conv_123" });
    });

    it("passes title, agentId, tags, metadata", async () => {
      mockFetch.mockResolvedValueOnce(sseResponse({ conversation_id: "conv_456" }));
      await engram.createConversation({
        title: "Test",
        agentId: "agent-1",
        tags: ["dev"],
        metadata: { env: "test" },
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.params.arguments).toEqual({
        title: "Test",
        agent_id: "agent-1",
        tags: ["dev"],
        metadata: { env: "test" },
      });
    });
  });

  describe("store", () => {
    it("stores messages and returns IDs", async () => {
      mockFetch.mockResolvedValueOnce(
        sseResponse({ appended: 2, message_ids: ["msg_a", "msg_b"] }),
      );

      const result = await engram.store({
        conversationId: "conv_123",
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi!" },
        ],
      });

      expect(result).toEqual({ appended: 2, messageIds: ["msg_a", "msg_b"] });
    });

    it("maps toolName and toolCallId to snake_case", async () => {
      mockFetch.mockResolvedValueOnce(
        sseResponse({ appended: 1, message_ids: ["msg_c"] }),
      );

      await engram.store({
        conversationId: "conv_123",
        messages: [
          {
            role: "tool",
            content: "result",
            toolName: "deploy",
            toolCallId: "tc_1",
          },
        ],
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const msg = body.params.arguments.messages[0];
      expect(msg.tool_name).toBe("deploy");
      expect(msg.tool_call_id).toBe("tc_1");
      expect(msg.toolName).toBeUndefined();
      expect(msg.toolCallId).toBeUndefined();
    });
  });

  describe("search", () => {
    it("searches and returns mapped results", async () => {
      mockFetch.mockResolvedValueOnce(
        sseResponse({
          results: [
            {
              chunk_id: "chk_1",
              conversation_id: "conv_1",
              chunk_text: "[user]: hello",
              score: 0.95,
              start_sequence: 1,
              end_sequence: 3,
              messages: [
                {
                  id: "msg_1",
                  conversation_id: "conv_1",
                  organization_id: "org_1",
                  role: "user",
                  content: "hello",
                  tool_call_id: null,
                  tool_name: null,
                  sequence: 1,
                  metadata: {},
                  created_at: "2026-04-06",
                },
              ],
            },
          ],
          total: 1,
        }),
      );

      const result = await engram.search({ query: "hello", limit: 5 });

      expect(result.total).toBe(1);
      expect(result.results[0].chunkId).toBe("chk_1");
      expect(result.results[0].conversationId).toBe("conv_1");
      expect(result.results[0].score).toBe(0.95);
      expect(result.results[0].messages[0].id).toBe("msg_1");
      expect(result.results[0].messages[0].conversationId).toBe("conv_1");
    });
  });

  describe("getConversation", () => {
    it("accepts a string shorthand", async () => {
      mockFetch.mockResolvedValueOnce(
        sseResponse({
          conversation: {
            id: "conv_1",
            organization_id: "org_1",
            title: "Test",
            agent_id: null,
            tags: [],
            metadata: {},
            message_count: 0,
            created_at: "2026-04-06",
            updated_at: "2026-04-06",
          },
          messages: [],
        }),
      );

      const result = await engram.getConversation("conv_1");
      expect(result.conversation.id).toBe("conv_1");
      expect(result.conversation.organizationId).toBe("org_1");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.params.arguments.conversation_id).toBe("conv_1");
    });

    it("accepts pagination params", async () => {
      mockFetch.mockResolvedValueOnce(
        sseResponse({
          conversation: {
            id: "conv_1",
            organization_id: "org_1",
            title: null,
            agent_id: null,
            tags: [],
            metadata: {},
            message_count: 50,
            created_at: "2026-04-06",
            updated_at: "2026-04-06",
          },
          messages: [],
        }),
      );

      await engram.getConversation({
        conversationId: "conv_1",
        messageLimit: 10,
        messageOffset: 20,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.params.arguments.message_limit).toBe(10);
      expect(body.params.arguments.message_offset).toBe(20);
    });
  });

  describe("listConversations", () => {
    it("lists with defaults", async () => {
      mockFetch.mockResolvedValueOnce(
        sseResponse({ conversations: [], total: 0 }),
      );

      const result = await engram.listConversations();
      expect(result).toEqual({ conversations: [], total: 0 });
    });

    it("passes all filter params", async () => {
      mockFetch.mockResolvedValueOnce(
        sseResponse({ conversations: [], total: 0 }),
      );

      await engram.listConversations({
        limit: 5,
        offset: 10,
        agentId: "agent-1",
        tags: ["prod"],
        sort: "message_count",
        order: "asc",
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.params.arguments).toEqual({
        limit: 5,
        offset: 10,
        agent_id: "agent-1",
        tags: ["prod"],
        sort: "message_count",
        order: "asc",
      });
    });
  });

  describe("deleteConversation", () => {
    it("deletes and returns result", async () => {
      mockFetch.mockResolvedValueOnce(sseResponse({ deleted: true }));
      const result = await engram.deleteConversation("conv_123");
      expect(result).toEqual({ deleted: true });
    });
  });

  describe("error handling", () => {
    it("throws AuthenticationError on 401", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 401,
        headers: new Headers(),
        text: () => Promise.resolve("Unauthorized"),
      });

      await expect(engram.createConversation()).rejects.toThrow(
        AuthenticationError,
      );
    });

    it("throws EngramError on server error response", async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse("Conversation not found"),
      );

      await expect(
        engram.getConversation("conv_nonexistent"),
      ).rejects.toThrow(EngramError);
    });

    it("throws on network error", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

      await expect(engram.search({ query: "test" })).rejects.toThrow(
        "Network error",
      );
    });
  });
});
