import { describe, it, expect } from "vitest";
import { searchEmptyTip, newUserAppendTip } from "../mcp/coaching.js";
import type { AuthContext } from "../types.js";

const oauthAuth = {
  apiKeyId: "oauth:client_abc",
  organizationId: "org_x",
  tier: "free",
} as unknown as AuthContext;

const keyAuth = {
  apiKeyId: "key_123",
  organizationId: "org_x",
  tier: "free",
} as unknown as AuthContext;

describe("coaching tips", () => {
  it("teaches on empty search results for OAuth clients only", () => {
    expect(searchEmptyTip(oauthAuth)).toMatch(/remember everything/i);
    expect(searchEmptyTip(keyAuth)).toBeUndefined();
  });

  it("tips new OAuth users on append; silent for veterans and API-key callers", () => {
    expect(newUserAppendTip(oauthAuth, 3)).toMatch(/remember everything/i);
    expect(newUserAppendTip(oauthAuth, 500)).toBeUndefined();
    expect(newUserAppendTip(oauthAuth, undefined)).toBeUndefined();
    expect(newUserAppendTip(keyAuth, 3)).toBeUndefined();
  });
});
