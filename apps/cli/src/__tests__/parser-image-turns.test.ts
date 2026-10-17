import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Parser } from "../daemon/parser.js";
import type { ParsedMessage } from "../daemon/types.js";

/**
 * Claude Code writes a user turn as a plain string normally, and as an array
 * of content blocks the moment anything is attached. The parser's array
 * branch used to look only for tool_result, so an attachment dropped the
 * WHOLE turn — including the question typed next to it.
 *
 * Measured on the owner's transcripts before the fix: 214 user turns and
 * 413,471 characters of their own words never reached Engram, 106 of those
 * because a screenshot was attached. Nothing failed; the turns were simply
 * absent from memory, which is the worst shape a data-loss bug can take.
 *
 * The fixture is a real captured turn (base64 payload substituted for size).
 */
const FIXTURE = readFileSync(
  resolve(__dirname, "fixtures/user-turn-with-image.json"),
  "utf-8",
).trim();

const PATH = "/Users/x/.claude/projects/-Users-x-proj/sess.jsonl";

function parse(line: string): ParsedMessage[] {
  const out: ParsedMessage[] = [];
  const p = new Parser((_s, _m, msgs) => out.push(...msgs));
  p.processLine(line, PATH);
  p.flush();
  return out;
}

describe("user turns with attachments", () => {
  it("keeps the text typed alongside an image", () => {
    const msgs = parse(FIXTURE);
    expect(msgs.length).toBeGreaterThan(0);
    const user = msgs.find((m) => m.role === "user");
    expect(user).toBeDefined();
    expect(user!.content).toContain("what happens");
  });

  it("records that an image was there, with type and size", () => {
    const user = parse(FIXTURE).find((m) => m.role === "user")!;
    expect(user.content).toMatch(/\[image attached: PNG, \d+ KB\]/);
  });

  it("stores no base64 payload — Engram is text", () => {
    const user = parse(FIXTURE).find((m) => m.role === "user")!;
    expect(user.content.length).toBeLessThan(2000);
    expect(user.content).not.toContain("AAAAAAAAAA");
  });

  it("still keeps text when the array holds only text", () => {
    const line = JSON.stringify({
      type: "user",
      sessionId: "s",
      message: { role: "user", content: [{ type: "text", text: "just words" }] },
    });
    const user = parse(line).find((m) => m.role === "user");
    expect(user?.content).toBe("just words");
  });

  it("still extracts tool results, and puts the user's words first", () => {
    const line = JSON.stringify({
      type: "user",
      sessionId: "s",
      message: {
        role: "user",
        content: [
          { type: "text", text: "see attached" },
          { type: "tool_result", tool_use_id: "t1", content: "result body" },
        ],
      },
    });
    const msgs = parse(line);
    expect(msgs.map((m) => m.role)).toEqual(["user", "tool"]);
    expect(msgs[1].toolCallId).toBe("t1");
  });

  it("leaves plain string turns exactly as they were", () => {
    const line = JSON.stringify({
      type: "user",
      sessionId: "s",
      message: { role: "user", content: "plain string turn" },
    });
    expect(parse(line)[0].content).toBe("plain string turn");
  });
});
