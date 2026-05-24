import { describe, it, expect } from "vitest";
import {
  createVaultToken,
  extractVaultIds,
  replaceVaultTokens,
} from "../utils/vault.js";

describe("createVaultToken", () => {
  it("creates token with correct format", () => {
    const token = createVaultToken("vlt_abc123");
    expect(token).toBe("[VAULT:vlt_abc123]");
  });

  it("wraps arbitrary vault IDs", () => {
    const token = createVaultToken("vlt_XYZ_test-id");
    expect(token).toBe("[VAULT:vlt_XYZ_test-id]");
  });
});

describe("extractVaultIds", () => {
  it("returns empty array for text without tokens", () => {
    expect(extractVaultIds("Hello world")).toEqual([]);
  });

  it("extracts a single vault ID", () => {
    const text = "Use [VAULT:vlt_abc123] for auth";
    expect(extractVaultIds(text)).toEqual(["vlt_abc123"]);
  });

  it("extracts multiple vault IDs", () => {
    const text =
      "Key [VAULT:vlt_first] and secret [VAULT:vlt_second] here";
    expect(extractVaultIds(text)).toEqual(["vlt_first", "vlt_second"]);
  });

  it("ignores malformed tokens", () => {
    const text = "[VAULT:] and [VAULT:bad format] and [VAULT:vlt_good]";
    const ids = extractVaultIds(text);
    expect(ids).toContain("vlt_good");
    expect(ids).not.toContain("");
  });
});

describe("replaceVaultTokens", () => {
  it("replaces tokens with resolved values", () => {
    const text = "Key is [VAULT:vlt_abc123]";
    const resolved = new Map([["vlt_abc123", "sk-mysecretkey"]]);
    expect(replaceVaultTokens(text, resolved)).toBe("Key is sk-mysecretkey");
  });

  it("replaces multiple tokens", () => {
    const text = "[VAULT:vlt_a] and [VAULT:vlt_b]";
    const resolved = new Map([
      ["vlt_a", "secret1"],
      ["vlt_b", "secret2"],
    ]);
    expect(replaceVaultTokens(text, resolved)).toBe("secret1 and secret2");
  });

  it("leaves unresolved tokens as-is", () => {
    const text = "[VAULT:vlt_known] and [VAULT:vlt_unknown]";
    const resolved = new Map([["vlt_known", "value"]]);
    expect(replaceVaultTokens(text, resolved)).toBe(
      "value and [VAULT:vlt_unknown]"
    );
  });

  it("returns original text when no tokens present", () => {
    const text = "Just a normal message";
    expect(replaceVaultTokens(text, new Map())).toBe(text);
  });

  it("returns original text when map is empty", () => {
    const text = "[VAULT:vlt_abc]";
    expect(replaceVaultTokens(text, new Map())).toBe("[VAULT:vlt_abc]");
  });
});
