import { describe, it, expect } from "vitest";
import {
  ALL_SCOPES,
  isScope,
  parseScopes,
  hasScope,
  scopeError,
} from "../mcp/scopes.js";
import type { AuthContext } from "../types.js";

function auth(scopes: AuthContext["scopes"]): AuthContext {
  return { organizationId: "org", apiKeyId: "key", tier: "free", scopes };
}

describe("api-key scopes (#69)", () => {
  it("isScope validates known scopes", () => {
    expect(isScope("read")).toBe(true);
    expect(isScope("admin")).toBe(false);
  });

  it("parseScopes splits and validates, ignoring junk", () => {
    expect(parseScopes("read,search")).toEqual(["read", "search"]);
    expect(parseScopes("read, delete , bogus")).toEqual(["read", "delete"]);
  });

  it("parseScopes defaults to full access for empty/garbled input", () => {
    expect(parseScopes(null)).toEqual(ALL_SCOPES);
    expect(parseScopes("")).toEqual(ALL_SCOPES);
    expect(parseScopes("nonsense")).toEqual(ALL_SCOPES);
  });

  it("hasScope checks the caller's granted scopes", () => {
    expect(hasScope(auth(["search"]), "search")).toBe(true);
    expect(hasScope(auth(["search"]), "write")).toBe(false);
  });

  it("scopeError is an MCP error result naming the missing scope", () => {
    const err = scopeError("delete");
    expect(err.isError).toBe(true);
    const payload = JSON.parse(err.content[0].text) as Record<string, unknown>;
    expect(payload.error).toBe("insufficient_scope");
    expect(payload.required).toBe("delete");
  });
});
