import { describe, it, expect } from "vitest";
import { ftsRowid, orgFtsToken, ftsMatch } from "@getengram/db";

/**
 * A contentless FTS5 index returns rowids and nothing else, so these three
 * functions are the entire bridge between a MATCH result and the chunk it
 * came from. If any of them is unstable, keyword search silently returns the
 * wrong rows or none at all.
 */
describe("ftsRowid", () => {
  it("is deterministic — re-indexing a window must overwrite, not duplicate", () => {
    const id = "chk_conv_abc_10_20_0";
    expect(ftsRowid(id)).toBe(ftsRowid(id));
  });

  it("stays inside JavaScript's exact integer range", () => {
    // A rowid past 2^53 loses precision in JS and would address a different
    // row than the one written.
    for (const id of ["a", "chk_x", "chk_" + "z".repeat(200), "🙂"]) {
      const r = ftsRowid(id);
      expect(Number.isSafeInteger(r)).toBe(true);
      expect(r).toBeGreaterThan(0);
    }
  });

  it("separates ids that differ only slightly", () => {
    expect(ftsRowid("chk_conv_a_1_2_0")).not.toBe(ftsRowid("chk_conv_a_1_2_1"));
    expect(ftsRowid("chk_conv_a_1_2_0")).not.toBe(ftsRowid("chk_conv_b_1_2_0"));
  });

  it("has no collisions across a realistic id space", () => {
    // Shape mirrors chunkId(): conversation + sequence window + index.
    const seen = new Set<number>();
    for (let conv = 0; conv < 200; conv++) {
      for (let seq = 0; seq < 50; seq++) {
        seen.add(ftsRowid(`chk_conv_${conv}_${seq * 6}_${seq * 6 + 5}_0`));
      }
    }
    expect(seen.size).toBe(200 * 50);
  });
});

describe("orgFtsToken", () => {
  it("collapses an org id to a single FTS token", () => {
    // unicode61 splits on non-alphanumerics, so `org_Abc` would index as
    // `org` + `abc` and EVERY org would share the `org` token.
    expect(orgFtsToken("org_Osnqdz3Hhf7RZZNk2dnBW")).toBe("orgOsnqdz3Hhf7RZZNk2dnBW");
    expect(orgFtsToken("org_a-b_c")).toMatch(/^[A-Za-z0-9]+$/);
  });

  it("is stable for the same id", () => {
    expect(orgFtsToken("org_x-y")).toBe(orgFtsToken("org_x-y"));
  });
});

describe("ftsMatch", () => {
  it("scopes the query to one org inside the index", () => {
    expect(ftsMatch("deploy", "org_abc")).toBe("org:orgabc AND (deploy)");
  });

  it("preserves FTS5 operators the user may have typed", () => {
    const m = ftsMatch('"exact phrase" OR pref*', "org_abc");
    expect(m).toContain('"exact phrase" OR pref*');
    expect(m.startsWith("org:orgabc AND (")).toBe(true);
  });

  it("documents that the token is not the tenant boundary", () => {
    // These two distinct org ids collapse to the same token. That is
    // ACCEPTABLE only because every caller also filters on
    // conversation_chunks.organization_id in the join — this test exists to
    // make that dependency explicit rather than incidental.
    expect(orgFtsToken("org_ab-cd")).toBe(orgFtsToken("org_abcd"));
  });
});
