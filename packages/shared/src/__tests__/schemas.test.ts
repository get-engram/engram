import { describe, it, expect } from "vitest";
import {
  MessageInputSchema,
  CreateConversationSchema,
  AppendMessagesSchema,
  SearchSchema,
  GetConversationSchema,
  ListConversationsSchema,
  DeleteConversationSchema,
} from "../schemas/index.js";

describe("MessageInputSchema", () => {
  it("accepts valid user message", () => {
    const result = MessageInputSchema.safeParse({
      role: "user",
      content: "Hello world",
    });
    expect(result.success).toBe(true);
  });

  it("accepts all valid roles", () => {
    for (const role of ["user", "assistant", "system", "tool"]) {
      const result = MessageInputSchema.safeParse({ role, content: "test" });
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid role", () => {
    const result = MessageInputSchema.safeParse({
      role: "admin",
      content: "test",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing content", () => {
    const result = MessageInputSchema.safeParse({ role: "user" });
    expect(result.success).toBe(false);
  });

  it("accepts optional tool fields", () => {
    const result = MessageInputSchema.safeParse({
      role: "tool",
      content: "result: 42",
      tool_call_id: "call_123",
      tool_name: "calculator",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tool_call_id).toBe("call_123");
      expect(result.data.tool_name).toBe("calculator");
    }
  });

  it("accepts optional metadata", () => {
    const result = MessageInputSchema.safeParse({
      role: "user",
      content: "test",
      metadata: { source: "api", priority: 1 },
    });
    expect(result.success).toBe(true);
  });
});

describe("CreateConversationSchema", () => {
  it("accepts empty object (all fields optional)", () => {
    const result = CreateConversationSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts all fields", () => {
    const result = CreateConversationSchema.safeParse({
      title: "My Conversation",
      agent_id: "agent_123",
      tags: ["dev", "test"],
      metadata: { project: "maas" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid tags type", () => {
    const result = CreateConversationSchema.safeParse({
      tags: "not-an-array",
    });
    expect(result.success).toBe(false);
  });
});

describe("AppendMessagesSchema", () => {
  it("accepts valid input", () => {
    const result = AppendMessagesSchema.safeParse({
      conversation_id: "conv_123",
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty messages array", () => {
    const result = AppendMessagesSchema.safeParse({
      conversation_id: "conv_123",
      messages: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing conversation_id", () => {
    const result = AppendMessagesSchema.safeParse({
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts multiple messages", () => {
    const result = AppendMessagesSchema.safeParse({
      conversation_id: "conv_123",
      messages: [
        { role: "user", content: "What is 2+2?" },
        { role: "assistant", content: "4" },
        { role: "tool", content: "verified", tool_name: "calc" },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.messages).toHaveLength(3);
    }
  });
});

describe("SearchSchema", () => {
  it("accepts minimal query", () => {
    const result = SearchSchema.safeParse({ query: "how to deploy" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(10); // default
    }
  });

  it("accepts all optional fields", () => {
    const result = SearchSchema.safeParse({
      query: "test",
      limit: 5,
      conversation_id: "conv_123",
      tags: ["prod"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects limit above 50", () => {
    const result = SearchSchema.safeParse({ query: "test", limit: 51 });
    expect(result.success).toBe(false);
  });

  it("rejects limit below 1", () => {
    const result = SearchSchema.safeParse({ query: "test", limit: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects missing query", () => {
    const result = SearchSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("GetConversationSchema", () => {
  it("accepts conversation_id only", () => {
    const result = GetConversationSchema.safeParse({
      conversation_id: "conv_abc",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message_limit).toBe(100);
      expect(result.data.message_offset).toBe(0);
    }
  });

  it("accepts custom pagination", () => {
    const result = GetConversationSchema.safeParse({
      conversation_id: "conv_abc",
      message_limit: 50,
      message_offset: 200,
    });
    expect(result.success).toBe(true);
  });

  it("rejects message_limit above 500", () => {
    const result = GetConversationSchema.safeParse({
      conversation_id: "conv_abc",
      message_limit: 501,
    });
    expect(result.success).toBe(false);
  });
});

describe("ListConversationsSchema", () => {
  it("accepts empty object with defaults", () => {
    const result = ListConversationsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(20);
      expect(result.data.offset).toBe(0);
      expect(result.data.sort).toBe("updated_at");
      expect(result.data.order).toBe("desc");
    }
  });

  it("accepts all sort options", () => {
    for (const sort of ["created_at", "updated_at", "message_count"]) {
      const result = ListConversationsSchema.safeParse({ sort });
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid sort field", () => {
    const result = ListConversationsSchema.safeParse({ sort: "name" });
    expect(result.success).toBe(false);
  });

  it("rejects invalid order", () => {
    const result = ListConversationsSchema.safeParse({ order: "random" });
    expect(result.success).toBe(false);
  });

  it("accepts tag filtering", () => {
    const result = ListConversationsSchema.safeParse({
      tags: ["prod", "v2"],
      agent_id: "agent_x",
    });
    expect(result.success).toBe(true);
  });
});

describe("DeleteConversationSchema", () => {
  it("accepts valid conversation_id", () => {
    const result = DeleteConversationSchema.safeParse({
      conversation_id: "conv_abc",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing conversation_id", () => {
    const result = DeleteConversationSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
