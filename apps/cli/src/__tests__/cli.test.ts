import { describe, it, expect } from "vitest";
import {
  linearize,
  linearizeClaude,
  normalizeExport,
  storagePrecheck,
  storageWarning,
  parseStorageFullError,
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

describe("import — lifetime storage pre-check (engram#275)", () => {
  it("fits when usage is unavailable (fetch failed — server enforces anyway)", () => {
    expect(storagePrecheck(50_000, null)).toEqual({ fits: true });
  });

  it("fits when the plan is unlimited (limit === -1)", () => {
    expect(storagePrecheck(5_000_000, { used: 123, limit: -1 })).toEqual({ fits: true });
  });

  it("fits when the export is within remaining space", () => {
    expect(storagePrecheck(8_900, { used: 1_100, limit: 10_000 })).toEqual({ fits: true });
    expect(storagePrecheck(0, { used: 10_000, limit: 10_000 })).toEqual({ fits: true });
  });

  it("does not fit when the export exceeds remaining space", () => {
    expect(storagePrecheck(42_310, { used: 1_100, limit: 10_000 })).toEqual({
      fits: false,
      remaining: 8_900,
      used: 1_100,
      limit: 10_000,
    });
  });

  it("clamps remaining to zero when already over the cap", () => {
    expect(storagePrecheck(1, { used: 10_001, limit: 10_000 })).toEqual({
      fits: false,
      remaining: 0,
      used: 10_001,
      limit: 10_000,
    });
  });

  it("formats the warning with counts and upgrade link", () => {
    const warning = storageWarning(42_310, { remaining: 8_900, limit: 10_000 });
    expect(warning).toContain("42,310 messages");
    expect(warning).toContain("8,900 of 10,000 messages of memory remaining");
    expect(warning).toContain("Importing will stop when memory is full");
    expect(warning).toContain("https://getengram.app/pricing");
  });
});

describe("import — storage_full error parsing", () => {
  it("parses the server's storage_full payload", () => {
    const raw = JSON.stringify({
      error: "storage_full",
      message: "Engram's memory is full (10,000 messages).",
      limit: 10_000,
      used: 10_000,
      tier: "free",
      upgrade_url: "https://getengram.app/pricing",
    });
    expect(parseStorageFullError(raw)).toEqual({
      message: "Engram's memory is full (10,000 messages).",
      limit: 10_000,
      used: 10_000,
      upgrade_url: "https://getengram.app/pricing",
    });
  });

  it("falls back to a default message when the payload has none", () => {
    const parsed = parseStorageFullError(JSON.stringify({ error: "storage_full" }));
    expect(parsed?.message).toBe("Engram's memory is full.");
  });

  it("returns null for other errors and non-JSON messages", () => {
    expect(parseStorageFullError("Network error: fetch failed")).toBeNull();
    expect(parseStorageFullError('{"error":"limit_exceeded","message":"x"}')).toBeNull();
    expect(parseStorageFullError("")).toBeNull();
  });
});
