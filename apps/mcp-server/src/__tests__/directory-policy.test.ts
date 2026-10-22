import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { SERVER_INSTRUCTIONS } from "../mcp/server.js";

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
});
