import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  SERVER_INSTRUCTIONS,
  VAULT_INSTRUCTIONS_OAUTH,
  VAULT_INSTRUCTIONS_FIRST_PARTY,
} from "../mcp/server.js";

/**
 * Anthropic's directory review rejected this listing on 2026-09-21 for text
 * injected into the assistant's context. The offending lines are long gone,
 * but nothing stopped them coming back — and a regression here is not a test
 * failure, it is a second rejection and another month of review.
 *
 * The rule the reviewer stated: instructions and tool descriptions say what a
 * tool does and when it applies. They do not tell the model to act, script
 * its wording, or advertise.
 */

const TOOLS_DIR = resolve(__dirname, "../mcp/tools");
const toolSources = readdirSync(TOOLS_DIR)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ file: f, text: readFileSync(resolve(TOOLS_DIR, f), "utf-8") }));

describe("Claude directory policy", () => {
  it("keeps imperatives aimed at the model out of the instructions", () => {
    // Verbatim from the rejection.
    for (const phrase of [
      "Use it proactively",
      "without waiting to be asked",
      "no permission-asking",
      "no preamble",
      "On the first user turn",
    ]) {
      expect(SERVER_INSTRUCTIONS, phrase).not.toContain(phrase);
    }
  });

  it("does not script the assistant's reply wording", () => {
    for (const phrase of [
      "Do NOT open by explaining",
      "the experienced save IS the onboarding",
      "at most ONE next thing",
      "Never present menus",
    ]) {
      expect(SERVER_INSTRUCTIONS, phrase).not.toContain(phrase);
    }
  });

  it("never reads as a request for the conversation history (OpenAI scanner, 2026-10-31)", () => {
    // OpenAI's automated scan flagged the server instructions and
    // append_messages as "appear to request the user's full conversation
    // history". These phrases were the trigger.
    const banned = [
      /save this chat/i,
      /from this point forward/i,
      /as the conversation continues/i,
      /standing (request|consent)/i,
      /current (exchange|conversation)/i,
      /ongoing saves/i,
      /(whole|entire|full) (conversation|chat|transcript)/i,
    ];
    const texts = [
      { file: "server.ts", text: SERVER_INSTRUCTIONS },
      ...toolSources,
      { file: "coaching.ts", text: readFileSync(resolve(__dirname, "../mcp/coaching.ts"), "utf-8") },
    ];
    for (const { file, text } of texts) {
      // Code comments are not model-visible; only strings reach the scanner.
      const visible = text.replace(/^\s*\/\/.*$/gm, "");
      for (const re of banned) expect(visible, `${file}: ${re}`).not.toMatch(re);
    }
  });

  it("names no competing assistant in the instructions", () => {
    expect(SERVER_INSTRUCTIONS).not.toMatch(/ChatGPT|Cursor|Gemini|Windsurf|Perplexity|OpenAI/i);
  });

  it("names no competing assistant in any tool schema", () => {
    for (const { file, text } of toolSources) {
      const described = text.match(/\.describe\(\s*(["'`])(?:\\.|(?!\1)[^\\])*\1/g) ?? [];
      for (const d of described) {
        expect(d, file).not.toMatch(/ChatGPT|Cursor|Gemini|Windsurf|Perplexity|OpenAI/i);
      }
    }
  });

  it("still discloses the team-account sharing default", () => {
    // The reviewer accepted disclosure instead of changing the default, so
    // the disclosure is now load-bearing — removing it reopens the finding.
    const src = readFileSync(resolve(TOOLS_DIR, "create-conversation.ts"), "utf-8");
    expect(src).toMatch(/visible to the whole team by default/i);
    expect(src).toMatch(/'private'/);
  });

  it("append_messages says where saved text goes, how to remove it, and who can see it (review, 2026-11-07)", () => {
    // The reviewer asked for this at save time, not only in create_conversation:
    // the default memory conversation is shared org-wide too.
    const src = readFileSync(resolve(TOOLS_DIR, "append-messages.ts"), "utf-8");
    expect(src).toMatch(/sent to and stored on Engram's servers/);
    expect(src).toMatch(/view saved messages with get_conversation/);
    expect(src).toMatch(/delete them with delete_conversation/);
    expect(src).toMatch(/visible to the whole team by default/i);
    expect(src).toMatch(/'private'/);
  });

  it("describes schema fields without telling the model what to pass on (review, 2026-11-07)", () => {
    for (const { file, text } of toolSources) {
      const described = text.match(/\.describe\(\s*(["'`])(?:\\.|(?!\1)[^\\])*\1/g) ?? [];
      for (const d of described) {
        expect(d, file).not.toMatch(/relay|tell the user|worth (mentioning|sharing)/i);
      }
    }
  });

  it("keeps the dashboard and history import out of the instructions (review, 2026-11-07)", () => {
    // "Move the import description to the docs": the dashboard pointer read
    // as marketing, and import is not something any tool here does.
    for (const text of [
      SERVER_INSTRUCTIONS + VAULT_INSTRUCTIONS_OAUTH,
      SERVER_INSTRUCTIONS + VAULT_INSTRUCTIONS_FIRST_PARTY,
    ]) {
      expect(text).not.toMatch(/dashboard/i);
      expect(text).not.toMatch(/\bimport(s|ed|ing)?\b/i);
    }
  });
});
