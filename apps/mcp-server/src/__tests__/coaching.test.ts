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
  tier: "x",
} as unknown as AuthContext;

// Directory policy (Anthropic + OpenAI rejections, Sept 2026): text injected
// into the model's context — server instructions, tool descriptions, AND tool
// outputs — must be factual/descriptive. No imperatives directing the model
// to call tools unprompted or skip permission, no scripted reply wording, no
// marketing/upsell URLs. These patterns were quoted verbatim in the
// rejections; reintroducing any of them gets the listings pulled.
const BANNED = [
  /proactiv/i,
  /without (being |waiting to be )?asked/i,
  /right now/i,
  /immediately/i,
  /no permission|don'?t ask permission|do not ask permission/i,
  /don'?t wait/i,
  /act[,.]? don'?t instruct/i,
  /getengram\.app/i, // upsell URLs belong in product surfaces, not injected context
];

function expectCompliant(text: string | undefined): void {
  expect(text).toBeDefined();
  for (const re of BANNED) {
    expect(text!, `banned pattern ${re} in: ${text}`).not.toMatch(re);
  }
}

describe("account-state notes (directory-compliant coaching)", () => {
  it("notes empty search results for OAuth clients only, factually", () => {
    const tip = searchEmptyTip(oauthAuth);
    expectCompliant(tip);
    expect(tip).toMatch(/no stored content/i);
    expect(searchEmptyTip(keyAuth)).toBeUndefined();
  });

  it("notes on append for new OAuth users; silent for veterans and API-key callers", () => {
    const tip = newUserAppendTip(oauthAuth, 3);
    expectCompliant(tip);
    expect(newUserAppendTip(oauthAuth, 500)).toBeUndefined();
    expect(newUserAppendTip(oauthAuth, undefined)).toBeUndefined();
    expect(newUserAppendTip(keyAuth, 3)).toBeUndefined();
  });

  it("first-run note fires only while the account holds nothing beyond the welcome note", () => {
    // 0 = truly empty, 1 = only the auto-seeded welcome note → note appears.
    expectCompliant(firstRunActivationForCount(oauthAuth, 0));
    expect(firstRunActivationForCount(oauthAuth, 1)).toMatch(/nothing has been saved/i);
    // 2+ = the user has saved something real → silent forever.
    expect(firstRunActivationForCount(oauthAuth, 2)).toBeUndefined();
    // Never for API-key/SDK callers (their agents self-drive).
    expect(firstRunActivationForCount(keyAuth, 0)).toBeUndefined();
  });

  it("first-save note fires exactly once — when the pre-append count was <= the welcome note", () => {
    expectCompliant(firstSaveCelebration(oauthAuth, 0));
    expect(firstSaveCelebration(oauthAuth, 1)).toMatch(/first memory/i);
    expect(firstSaveCelebration(oauthAuth, 2)).toBeUndefined();
    expect(firstSaveCelebration(oauthAuth, undefined)).toBeUndefined();
    expect(firstSaveCelebration(keyAuth, 0)).toBeUndefined();
  });

  it("every note is imperative-free and upsell-free (the rejection regression guard)", () => {
    for (const text of [
      searchEmptyTip(oauthAuth),
      newUserAppendTip(oauthAuth, 1),
      firstRunActivationForCount(oauthAuth, 0),
      firstSaveCelebration(oauthAuth, 0),
    ]) {
      expectCompliant(text);
    }
  });
});
