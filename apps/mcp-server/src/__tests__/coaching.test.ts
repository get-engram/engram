import { describe, it, expect } from "vitest";
import {
  searchEmptyTip,
  newUserAppendTip,
  firstRunActivationForCount,
  firstSaveCelebration,
} from "../mcp/coaching.js";
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

  it("first-run activation fires only while the account holds nothing beyond the welcome note", () => {
    // 0 = truly empty, 1 = only the auto-seeded welcome note → activate.
    expect(firstRunActivationForCount(oauthAuth, 0)).toMatch(/append_messages/);
    expect(firstRunActivationForCount(oauthAuth, 1)).toMatch(/brand-new chat/i);
    // 2+ = the user has saved something real → silent forever.
    expect(firstRunActivationForCount(oauthAuth, 2)).toBeUndefined();
    // Never for API-key/SDK callers (their agents self-drive).
    expect(firstRunActivationForCount(keyAuth, 0)).toBeUndefined();
  });

  it("first-save celebration fires exactly once — when the pre-append count was <= the welcome note", () => {
    expect(firstSaveCelebration(oauthAuth, 0)).toMatch(/FIRST saved memory/);
    // must instruct an immediate proof-by-search, not just a description
    expect(firstSaveCelebration(oauthAuth, 0)).toMatch(/`search`/);
    expect(firstSaveCelebration(oauthAuth, 1)).toMatch(/brand-new chat/i);
    expect(firstSaveCelebration(oauthAuth, 2)).toBeUndefined();
    expect(firstSaveCelebration(oauthAuth, undefined)).toBeUndefined();
    expect(firstSaveCelebration(keyAuth, 0)).toBeUndefined();
  });
});
