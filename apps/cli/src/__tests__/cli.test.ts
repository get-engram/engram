import { describe, it, expect } from "vitest";
import {
  linearize,
  linearizeClaude,
  normalizeExport,
  type ChatConversation,
} from "../commands/import.js";

describe("CLI", () => {
  it("exports all command modules", async () => {
    const auth = await import("../commands/auth.js");
    expect(auth.authLogin).toBeDefined();
    expect(auth.authLogout).toBeDefined();
    expect(auth.authStatus).toBeDefined();
  });

  it("exports conversation commands", async () => {
    const convs = await import("../commands/conversations.js");
    expect(convs.listConversations).toBeDefined();
    expect(convs.createConversation).toBeDefined();
    expect(convs.getConversation).toBeDefined();
    expect(convs.deleteConversation).toBeDefined();
  });

  it("exports store command", async () => {
    const { store } = await import("../commands/store.js");
    expect(store).toBeDefined();
  });

  it("exports search command", async () => {
    const { search } = await import("../commands/search.js");
    expect(search).toBeDefined();
  });

  it("output helpers format correctly", async () => {
    const { bold, dim, green, red, cyan } = await import("../output.js");
    expect(bold("test")).toContain("test");
    expect(dim("test")).toContain("test");
    expect(green("test")).toContain("test");
    expect(red("test")).toContain("test");
    expect(cyan("test")).toContain("test");
  });
});

describe("ChatGPT import — linearize", () => {
  const convo: ChatConversation = {
    title: "Test",
    current_node: "d",
    mapping: {
      root: { id: "root", parent: null, message: null },
      sys: { id: "sys", parent: "root", message: { author: { role: "system" }, content: { content_type: "text", parts: [""] } } },
      a: { id: "a", parent: "sys", message: { author: { role: "user" }, content: { content_type: "text", parts: ["hello"] } } },
      b: { id: "b", parent: "a", message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["hi there"] } } },
      tool: { id: "tool", parent: "b", message: { author: { role: "tool" }, content: { content_type: "code", parts: ["{}"] } } },
      d: { id: "d", parent: "tool", message: { author: { role: "user" }, content: { content_type: "text", parts: ["bye"] } } },
    },
  };

  it("keeps only user/assistant text messages, in chronological order", () => {
    const msgs = linearize(convo);
    expect(msgs).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "bye" },
    ]);
  });

  it("returns [] for an empty/parentless mapping", () => {
    expect(linearize({ current_node: "x", mapping: {} })).toEqual([]);
    expect(linearize({})).toEqual([]);
  });
});

describe("import — Claude + format detection", () => {
  it("linearizes a Claude conversation (text and content blocks)", () => {
    const msgs = linearizeClaude({
      name: "Test",
      chat_messages: [
        { sender: "human", text: "hi" },
        { sender: "assistant", content: [{ type: "text", text: "hello" }] },
        { sender: "tool", text: "ignored" },
        { sender: "human", text: "  " },
      ],
    });
    expect(msgs).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("detects ChatGPT vs Claude vs unknown", () => {
    expect(normalizeExport([{ mapping: {}, current_node: null }]).format).toBe("chatgpt");
    expect(normalizeExport([{ chat_messages: [] }]).format).toBe("claude");
    expect(normalizeExport([{ foo: "bar" }]).format).toBe("unknown");
    expect(normalizeExport([]).format).toBe("unknown");
  });

  it("normalizes Claude conversations with title + messages", () => {
    const { format, conversations } = normalizeExport([
      { name: "My chat", created_at: "2026-01-01", chat_messages: [{ sender: "human", text: "yo" }] },
    ]);
    expect(format).toBe("claude");
    expect(conversations[0].title).toBe("My chat");
    expect(conversations[0].messages).toEqual([{ role: "user", content: "yo" }]);
  });
});
