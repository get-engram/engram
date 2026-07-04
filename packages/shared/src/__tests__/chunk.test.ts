import { describe, it, expect, vi } from "vitest";
import { chunkMessages, estimateTokens, summarizeChunk } from "../utils/chunk.js";
import type { Message } from "../types/index.js";

const MAX_CHARS = 480 * 4; // mirrors MAX_TOKENS * CHARS_PER_TOKEN in chunk.ts

function makeMessage(sequence: number, role: string, content: string): Message {
  return {
    id: `msg_${sequence}`,
    conversation_id: "conv_test",
    organization_id: "org_test",
    role: role as Message["role"],
    content,
    tool_call_id: null,
    tool_name: null,
    sequence,
    metadata: {},
    created_at: "2024-01-01T00:00:00Z",
  };
}

describe("chunkMessages", () => {
  it("returns empty array for empty input", () => {
    expect(chunkMessages([])).toEqual([]);
  });

  it("creates a single chunk for fewer than 5 messages", () => {
    const messages = [
      makeMessage(1, "user", "Hello"),
      makeMessage(2, "assistant", "Hi there"),
      makeMessage(3, "user", "How are you?"),
    ];

    const chunks = chunkMessages(messages);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].startSequence).toBe(1);
    expect(chunks[0].endSequence).toBe(3);
    expect(chunks[0].text).toBe(
      "[user]: Hello\n[assistant]: Hi there\n[user]: How are you?"
    );
  });

  it("creates two chunks for exactly 5 messages (window=5, stride=3)", () => {
    // i=0: [1..5] (full window, continues)
    // i=3: [4,5] (2 msgs < WINDOW_SIZE, makes chunk then breaks)
    const messages = Array.from({ length: 5 }, (_, i) =>
      makeMessage(i + 1, i % 2 === 0 ? "user" : "assistant", `Message ${i + 1}`)
    );

    const chunks = chunkMessages(messages);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].startSequence).toBe(1);
    expect(chunks[0].endSequence).toBe(5);
    expect(chunks[1].startSequence).toBe(4);
    expect(chunks[1].endSequence).toBe(5);
  });

  it("creates overlapping chunks with stride of 3", () => {
    // 8 messages: window=5, stride=3
    // i=0: [1..5], i=3: [4..8] (full window, continues), i=6: [7,8] (< WINDOW_SIZE, stops)
    const messages = Array.from({ length: 8 }, (_, i) =>
      makeMessage(i + 1, i % 2 === 0 ? "user" : "assistant", `Message ${i + 1}`)
    );

    const chunks = chunkMessages(messages);
    expect(chunks).toHaveLength(3);

    expect(chunks[0].startSequence).toBe(1);
    expect(chunks[0].endSequence).toBe(5);

    expect(chunks[1].startSequence).toBe(4);
    expect(chunks[1].endSequence).toBe(8);

    expect(chunks[2].startSequence).toBe(7);
    expect(chunks[2].endSequence).toBe(8);
  });

  it("handles 10 messages with proper overlap", () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMessage(i + 1, "user", `Message ${i + 1}`)
    );

    const chunks = chunkMessages(messages);
    // i=0: [1..5], i=3: [4..8], i=6: [7..10] (only 4 messages, < WINDOW_SIZE, so stops after)
    expect(chunks).toHaveLength(3);

    expect(chunks[0].startSequence).toBe(1);
    expect(chunks[0].endSequence).toBe(5);

    expect(chunks[1].startSequence).toBe(4);
    expect(chunks[1].endSequence).toBe(8);

    expect(chunks[2].startSequence).toBe(7);
    expect(chunks[2].endSequence).toBe(10);
  });

  it("sorts messages by sequence before chunking", () => {
    const messages = [
      makeMessage(3, "user", "Third"),
      makeMessage(1, "user", "First"),
      makeMessage(2, "assistant", "Second"),
    ];

    const chunks = chunkMessages(messages);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(
      "[user]: First\n[assistant]: Second\n[user]: Third"
    );
  });

  it("formats chunk text as [role]: content", () => {
    const messages = [
      makeMessage(1, "system", "You are helpful"),
      makeMessage(2, "user", "What is 2+2?"),
      makeMessage(3, "assistant", "4"),
      makeMessage(4, "tool", "calculator result: 4"),
    ];

    const chunks = chunkMessages(messages);
    expect(chunks[0].text).toContain("[system]: You are helpful");
    expect(chunks[0].text).toContain("[user]: What is 2+2?");
    expect(chunks[0].text).toContain("[assistant]: 4");
    expect(chunks[0].text).toContain("[tool]: calculator result: 4");
  });

  it("handles a single message", () => {
    const messages = [makeMessage(1, "user", "Hello")];

    const chunks = chunkMessages(messages);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].startSequence).toBe(1);
    expect(chunks[0].endSequence).toBe(1);
    expect(chunks[0].text).toBe("[user]: Hello");
  });

  describe("token-aware splitting (#45)", () => {
    it("estimateTokens approximates chars/4", () => {
      expect(estimateTokens("")).toBe(0);
      expect(estimateTokens("abcd")).toBe(1);
      expect(estimateTokens("a".repeat(2000))).toBe(500);
    });

    it("keeps every chunk within the embedding budget when a window overflows", () => {
      const onWarn = vi.fn();
      // 5 messages of ~500 chars each => window well over MAX_CHARS.
      const messages = Array.from({ length: 5 }, (_, i) =>
        makeMessage(i + 1, "user", "x".repeat(500)),
      );

      const chunks = chunkMessages(messages, { onWarn });

      // The window got split, so we produce more than the naive 2 chunks.
      expect(chunks.length).toBeGreaterThan(2);
      for (const c of chunks) {
        expect(c.text.length).toBeLessThanOrEqual(MAX_CHARS);
      }
      // Multi-message split doesn't warn (no single message is oversized).
      expect(onWarn).not.toHaveBeenCalled();
    });

    it("hard-splits a single oversized message and warns", () => {
      const onWarn = vi.fn();
      const messages = [makeMessage(1, "user", "y".repeat(2500))];

      const chunks = chunkMessages(messages, { onWarn });

      expect(chunks.length).toBeGreaterThan(1);
      for (const c of chunks) {
        expect(c.text.length).toBeLessThanOrEqual(MAX_CHARS);
        // All pieces belong to the one message's sequence.
        expect(c.startSequence).toBe(1);
        expect(c.endSequence).toBe(1);
      }
      expect(onWarn).toHaveBeenCalledOnce();
    });
  });

  describe("summarizeChunk (#61)", () => {
    it("strips role prefixes and returns short text as-is", () => {
      expect(summarizeChunk("[user]: Fix the login bug")).toBe(
        "Fix the login bug",
      );
    });

    it("collapses whitespace across messages", () => {
      expect(
        summarizeChunk("[user]:  hello \n[assistant]:  hi   there"),
      ).toBe("hello hi there");
    });

    it("truncates long text to ~200 chars with an ellipsis or sentence end", () => {
      const long = "[user]: " + "word ".repeat(100);
      const summary = summarizeChunk(long);
      expect(summary.length).toBeLessThanOrEqual(201);
      expect(summary.length).toBeGreaterThan(80);
    });

    it("prefers a sentence boundary when one exists in range", () => {
      const text =
        "[assistant]: First sentence here. " + "x".repeat(300);
      expect(summarizeChunk(text)).toBe("First sentence here.");
    });
  });
});
