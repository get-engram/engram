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

describe("usage bars", () => {
  it("renders proportional bars with padded percentages", async () => {
    const { renderBar } = await import("../commands/usage.js");
    expect(renderBar(6_200, 10_000)).toBe("[████████████░░░░░░░░]  62%");
    expect(renderBar(0, 10_000)).toBe("[░░░░░░░░░░░░░░░░░░░░]   0%");
    expect(renderBar(10_000, 10_000)).toBe("[████████████████████] 100%");
    expect(renderBar(20_000, 10_000)).toBe("[████████████████████] 100%");
  });

  it("shows at least one filled segment for any nonzero usage", async () => {
    const { renderBar } = await import("../commands/usage.js");
    expect(renderBar(1, 10_000)).toBe("[█░░░░░░░░░░░░░░░░░░░]   0%");
    expect(renderBar(65, 10_000)).toBe("[█░░░░░░░░░░░░░░░░░░░]   1%");
  });
});

describe("import fingerprints (engram#254)", () => {
  it("carries the ChatGPT conversation id as sourceId", () => {
    const { conversations } = normalizeExport([
      { id: "abc-123", title: "T", mapping: {}, current_node: null },
    ]);
    expect(conversations[0].sourceId).toBe("abc-123");
  });

  it("falls back to conversation_id and null when absent", () => {
    const { conversations } = normalizeExport([
      { conversation_id: "xyz", mapping: {}, current_node: null },
      { mapping: {}, current_node: null },
    ]);
    expect(conversations[0].sourceId).toBe("xyz");
    expect(conversations[1].sourceId).toBeNull();
  });

  it("carries the Claude uuid as sourceId", () => {
    const { conversations } = normalizeExport([
      { uuid: "u-1", name: "N", chat_messages: [] },
    ]);
    expect(conversations[0].sourceId).toBe("u-1");
  });
});

describe("share-link import (extractSharedConversation)", () => {
  const CONVO = {
    title: "Rescued chat",
    conversation_id: "abc-123",
    current_node: "n2",
    mapping: {
      n1: { id: "n1", parent: null, message: { author: { role: "user" }, content: { content_type: "text", parts: ["hello"] } } },
      n2: { id: "n2", parent: "n1", message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["hi there"] } } },
    },
  };

  it("finds the conversation in a JSON script tag", async () => {
    const { extractSharedConversation } = await import("../commands/import.js");
    const html = `<html><head><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { serverResponse: { data: CONVO } } } })}</script></head><body></body></html>`;
    const found = extractSharedConversation(html);
    expect(found?.title).toBe("Rescued chat");
    expect(Object.keys(found?.mapping ?? {})).toHaveLength(2);
  });

  it("finds the conversation in an inline __remixContext assignment", async () => {
    const { extractSharedConversation } = await import("../commands/import.js");
    const html = `<script>window.__remixContext = ${JSON.stringify({ state: { loaderData: { route: { serverResponse: CONVO } } } })};</script>`;
    const found = extractSharedConversation(html);
    expect(found?.conversation_id).toBe("abc-123");
  });

  it("returns null when no conversation JSON is present", async () => {
    const { extractSharedConversation } = await import("../commands/import.js");
    expect(extractSharedConversation("<html><body>nothing here</body></html>")).toBeNull();
  });

  it("linearizes the extracted conversation like an export", async () => {
    const { extractSharedConversation, normalizeExport } = await import("../commands/import.js");
    const html = `<script type="application/json">${JSON.stringify({ data: CONVO })}</script>`;
    const convo = extractSharedConversation(html)!;
    const { format, conversations } = normalizeExport([convo]);
    expect(format).toBe("chatgpt");
    expect(conversations[0].messages.map((m) => m.content)).toEqual(["hello", "hi there"]);
  });

  it("recognizes share URLs and not other input", async () => {
    const { SHARE_URL_RE } = await import("../commands/import.js");
    expect(SHARE_URL_RE.test("https://chatgpt.com/share/e6a1c9e2-1234-4abc-9def-aaaa00001111")).toBe(true);
    expect(SHARE_URL_RE.test("https://chat.openai.com/share/e6a1c9e2")).toBe(true);
    expect(SHARE_URL_RE.test("conversations.json")).toBe(false);
    expect(SHARE_URL_RE.test("https://example.com/share/x")).toBe(false);
  });
});
