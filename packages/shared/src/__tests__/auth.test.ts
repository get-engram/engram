import { describe, it, expect } from "vitest";
import { hashApiKey } from "../utils/auth.js";

describe("hashApiKey", () => {
  it("returns a 64-character hex string", async () => {
    const hash = await hashApiKey("test-key");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces deterministic output", async () => {
    const hash1 = await hashApiKey("maas_sk_live_abc123");
    const hash2 = await hashApiKey("maas_sk_live_abc123");
    expect(hash1).toBe(hash2);
  });

  it("produces different hashes for different keys", async () => {
    const hash1 = await hashApiKey("key_one");
    const hash2 = await hashApiKey("key_two");
    expect(hash1).not.toBe(hash2);
  });

  it("produces known SHA-256 hash for empty string", async () => {
    const hash = await hashApiKey("");
    // SHA-256 of empty string
    expect(hash).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });
});
