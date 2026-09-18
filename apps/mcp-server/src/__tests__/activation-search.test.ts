import { describe, it, expect } from "vitest";
import { isSystemConversation } from "../services/search.js";

// Activation (2026-09): the seeded welcome note must not surface as a search
// hit — a brand-new user's first "what do you remember?" should return their
// real memory (or a clean empty result that triggers the coaching tip), not
// Engram's own onboarding boilerplate presented as if they'd written it.

describe("isSystemConversation", () => {
  it("matches the seeded welcome note metadata", () => {
    expect(isSystemConversation('{"system":true,"type":"welcome"}')).toBe(true);
    expect(isSystemConversation('{"system":true}')).toBe(true);
  });

  it("does not match a real user conversation", () => {
    expect(isSystemConversation('{"project":"engram"}')).toBe(false);
    expect(isSystemConversation("{}")).toBe(false);
    expect(isSystemConversation(null)).toBe(false);
    expect(isSystemConversation(undefined)).toBe(false);
  });

  it("is robust to malformed metadata", () => {
    expect(isSystemConversation("not json")).toBe(false);
  });
});
