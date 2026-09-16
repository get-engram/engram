import { describe, it, expect } from "vitest";
import { oauthScopeToInternal } from "../mcp/scopes.js";

// The OAuth vocabulary is only engram:read / engram:write (no delete). Auth
// used to grant every OAuth token the full internal set including delete, so a
// read-only consent silently permitted writes and deletes. These pin the
// least-privilege mapping and, critically, that delete is NEVER granted.

describe("oauthScopeToInternal", () => {
  it("maps engram:read to read + search only", () => {
    expect(oauthScopeToInternal("engram:read").sort()).toEqual(["read", "search"]);
  });

  it("maps engram:read engram:write to read + search + write, never delete", () => {
    const s = oauthScopeToInternal("engram:read engram:write");
    expect(s.sort()).toEqual(["read", "search", "write"]);
    expect(s).not.toContain("delete");
  });

  it("NEVER grants delete, even if a delete-like scope is somehow present", () => {
    expect(oauthScopeToInternal("engram:read engram:delete delete")).not.toContain("delete");
  });

  it("accepts comma or space separated scope strings", () => {
    expect(oauthScopeToInternal("engram:read,engram:write").sort()).toEqual([
      "read",
      "search",
      "write",
    ]);
  });

  it("falls back to read+search+write (not delete, not lockout) for empty/garbled scope", () => {
    for (const bad of ["", null, undefined, "garbage nonsense"]) {
      const s = oauthScopeToInternal(bad as string);
      expect(s.sort()).toEqual(["read", "search", "write"]);
      expect(s).not.toContain("delete");
    }
  });
});
