import { describe, it, expect, beforeAll } from "vitest";
import { generateVaultKey, processContent, resolveContent } from "../vault.js";
import type { VaultConfig } from "../vault.js";

describe("generateVaultKey", () => {
  it("returns a base64 string", async () => {
    const key = await generateVaultKey();
    expect(typeof key).toBe("string");
    // Should be valid base64
    const bytes = Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
    expect(bytes.length).toBe(32);
  });

  it("generates unique keys each time", async () => {
    const key1 = await generateVaultKey();
    const key2 = await generateVaultKey();
    expect(key1).not.toBe(key2);
  });
});

describe("processContent", () => {
  let config: VaultConfig;

  // Generate a key once for all tests in this suite
  const keyPromise = generateVaultKey();

  beforeAll(async () => {
    config = { encryptionKey: await keyPromise };
  });

  it("passes through content with no secrets", async () => {
    const result = await processContent("Hello, world!", config);
    expect(result.content).toBe("Hello, world!");
    expect(result.vaultEntries).toHaveLength(0);
  });

  it("detects and replaces an API key", async () => {
    const original = "Use key sk-abcdefghijklmnopqrstuvwxyz1234";
    const result = await processContent(original, config);

    expect(result.content).not.toContain("sk-abcdefghijklmnopqrstuvwxyz1234");
    expect(result.content).toMatch(/\[VAULT:vlt_[A-Za-z0-9_-]+\]/);
    expect(result.vaultEntries).toHaveLength(1);
    expect(result.vaultEntries[0].secret_type).toBe("api_key");
    expect(result.vaultEntries[0].id).toMatch(/^vlt_/);
    expect(result.vaultEntries[0].encrypted_value).toBeTruthy();
    expect(result.vaultEntries[0].iv).toBeTruthy();
  });

  it("detects and replaces an SSN", async () => {
    const original = "My SSN is 123-45-6789";
    const result = await processContent(original, config);

    expect(result.content).not.toContain("123-45-6789");
    expect(result.content).toMatch(/\[VAULT:vlt_/);
    expect(result.vaultEntries).toHaveLength(1);
    expect(result.vaultEntries[0].secret_type).toBe("ssn");
  });

  it("detects and replaces a JWT", async () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const original = `Bearer ${jwt}`;
    const result = await processContent(original, config);

    expect(result.content).not.toContain(jwt);
    expect(result.vaultEntries.length).toBeGreaterThanOrEqual(1);
  });

  it("detects and replaces a connection string", async () => {
    const original = "Connect to postgres://admin:secret@db.example.com:5432/mydb";
    const result = await processContent(original, config);

    expect(result.content).not.toContain("postgres://");
    expect(result.vaultEntries).toHaveLength(1);
    expect(result.vaultEntries[0].secret_type).toBe("connection_string");
  });

  it("detects and replaces an email", async () => {
    const original = "Contact admin@example.com for help";
    const result = await processContent(original, config);

    expect(result.content).not.toContain("admin@example.com");
    expect(result.vaultEntries).toHaveLength(1);
    expect(result.vaultEntries[0].secret_type).toBe("email");
  });

  it("handles multiple secrets in one message", async () => {
    const original =
      "Key sk-abcdefghijklmnopqrstuvwxyz1234 and SSN 123-45-6789";
    const result = await processContent(original, config);

    expect(result.content).not.toContain("sk-abcdefghijklmnopqrstuvwxyz1234");
    expect(result.content).not.toContain("123-45-6789");
    expect(result.vaultEntries).toHaveLength(2);
  });

  it("generates unique vault IDs per secret", async () => {
    const original =
      "Key sk-abcdefghijklmnopqrstuvwxyz1234 and SSN 123-45-6789";
    const result = await processContent(original, config);

    const ids = result.vaultEntries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("vault tokens in content match entry IDs", async () => {
    const original = "Key sk-abcdefghijklmnopqrstuvwxyz1234";
    const result = await processContent(original, config);

    const tokenMatch = result.content.match(
      /\[VAULT:(vlt_[A-Za-z0-9_-]+)\]/
    );
    expect(tokenMatch).not.toBeNull();
    expect(tokenMatch![1]).toBe(result.vaultEntries[0].id);
  });
});

describe("resolveContent", () => {
  let config: VaultConfig;
  const keyPromise = generateVaultKey();

  beforeAll(async () => {
    config = { encryptionKey: await keyPromise };
  });

  it("passes through content with no vault tokens", async () => {
    const result = await resolveContent("Hello world", [], config);
    expect(result).toBe("Hello world");
  });

  it("round-trips: process then resolve returns original", async () => {
    const original = "My API key is sk-abcdefghijklmnopqrstuvwxyz1234 okay";
    const processed = await processContent(original, config);
    const resolved = await resolveContent(
      processed.content,
      processed.vaultEntries,
      config
    );

    expect(resolved).toBe(original);
  });

  it("round-trips multiple secrets", async () => {
    const original =
      "Key sk-abcdefghijklmnopqrstuvwxyz1234 and SSN 123-45-6789 and email admin@example.com";
    const processed = await processContent(original, config);
    const resolved = await resolveContent(
      processed.content,
      processed.vaultEntries,
      config
    );

    expect(resolved).toBe(original);
  });

  it("leaves unresolved vault tokens as-is", async () => {
    const content = "Secret is [VAULT:vlt_unknown123456789ab]";
    const resolved = await resolveContent(content, [], config);
    expect(resolved).toBe(content);
  });

  it("fails with wrong decryption key", async () => {
    const original = "Key sk-abcdefghijklmnopqrstuvwxyz1234";
    const processed = await processContent(original, config);

    const wrongKey = await generateVaultKey();
    const wrongConfig = { encryptionKey: wrongKey };

    await expect(
      resolveContent(processed.content, processed.vaultEntries, wrongConfig)
    ).rejects.toThrow();
  });
});

describe("key validation", () => {
  it("rejects keys that are not 32 bytes", async () => {
    const shortKey = btoa("tooshort");
    const config = { encryptionKey: shortKey };

    await expect(
      processContent("sk-abcdefghijklmnopqrstuvwxyz1234", config)
    ).rejects.toThrow("32 bytes");
  });
});
