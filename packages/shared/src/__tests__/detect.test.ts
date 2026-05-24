import { describe, it, expect } from "vitest";
import { detectSecrets } from "../utils/detect.js";

describe("detectSecrets", () => {
  it("returns empty array for clean text", () => {
    expect(detectSecrets("Hello, this is a normal message.")).toEqual([]);
  });

  // --- API Keys ---

  it("detects OpenAI API keys", () => {
    const text = "Use sk-abcdefghijklmnopqrstuvwxyz1234 for auth";
    const results = detectSecrets(text);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("api_key");
    expect(results[0].value).toBe("sk-abcdefghijklmnopqrstuvwxyz1234");
  });

  it("detects Anthropic API keys", () => {
    const text = "Key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
    const results = detectSecrets(text);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("api_key");
  });

  it("detects AWS access keys", () => {
    const text = "AWS key AKIAIOSFODNN7EXAMPLE";
    const results = detectSecrets(text);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("api_key");
    expect(results[0].value).toBe("AKIAIOSFODNN7EXAMPLE");
  });

  it("detects GitHub tokens", () => {
    const text = "Use ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl for auth";
    const results = detectSecrets(text);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("api_key");
  });

  it("detects Stripe keys", () => {
    const text = "sk_live_abcdefghijklmnop";
    const results = detectSecrets(text);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("api_key");
  });

  // --- JWTs ---

  it("detects JWTs", () => {
    const text =
      "Token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const results = detectSecrets(text);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("jwt");
  });

  // --- Connection Strings ---

  it("detects PostgreSQL connection strings", () => {
    const text = "Connect to postgres://user:pass@host:5432/db";
    const results = detectSecrets(text);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("connection_string");
  });

  it("detects Redis connection strings", () => {
    const text = "redis://default:secret@cache.example.com:6379";
    const results = detectSecrets(text);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("connection_string");
  });

  it("detects MongoDB connection strings", () => {
    const text = "mongodb+srv://admin:password@cluster.mongodb.net/mydb";
    const results = detectSecrets(text);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("connection_string");
  });

  // --- Secret Assignments ---

  it("detects password assignments", () => {
    const text = 'DB_PASSWORD="supersecret123"';
    const results = detectSecrets(text);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("secret_assignment");
  });

  it("detects api_key assignments", () => {
    const text = "api_key: my_secret_value_here";
    const results = detectSecrets(text);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("secret_assignment");
  });

  // --- PII ---

  it("detects SSNs", () => {
    const text = "SSN is 123-45-6789";
    const results = detectSecrets(text);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("ssn");
    expect(results[0].value).toBe("123-45-6789");
  });

  it("detects email addresses", () => {
    const text = "Email me at user@example.com";
    const results = detectSecrets(text);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("email");
    expect(results[0].value).toBe("user@example.com");
  });

  it("detects phone numbers", () => {
    const text = "Call me at (555) 123-4567";
    const results = detectSecrets(text);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("phone");
  });

  // --- PEM Private Keys ---

  it("detects PEM private keys", () => {
    const text = `Here is a key:
-----BEGIN RSA PRIVATE KEY-----
MIIBogIBAAJBALRiMLAHudeSA/x3hB2f+2NRkJLA
-----END RSA PRIVATE KEY-----
Done.`;
    const results = detectSecrets(text);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("private_key");
  });

  // --- Generic Tokens ---

  it("detects long hex tokens", () => {
    const text = "Hash abcdef0123456789abcdef0123456789 found";
    const results = detectSecrets(text);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("token");
  });

  // --- Position tracking ---

  it("returns correct start and end positions", () => {
    const text = "My SSN is 123-45-6789 ok";
    const results = detectSecrets(text);
    expect(results).toHaveLength(1);
    expect(results[0].start).toBe(10);
    expect(results[0].end).toBe(21);
    expect(text.slice(results[0].start, results[0].end)).toBe("123-45-6789");
  });

  // --- Multiple secrets ---

  it("detects multiple secrets in one string", () => {
    const text =
      "Use sk-abcdefghijklmnopqrstuvwxyz1234 and SSN 123-45-6789 to connect to postgres://u:p@host/db";
    const results = detectSecrets(text);
    expect(results.length).toBeGreaterThanOrEqual(3);
    const types = results.map((r) => r.type);
    expect(types).toContain("api_key");
    expect(types).toContain("ssn");
    expect(types).toContain("connection_string");
  });

  // --- Ordering ---

  it("returns results sorted by start position", () => {
    const text = "SSN 123-45-6789 and email user@example.com";
    const results = detectSecrets(text);
    for (let i = 1; i < results.length; i++) {
      expect(results[i].start).toBeGreaterThanOrEqual(results[i - 1].start);
    }
  });

  // --- No overlaps ---

  it("returns non-overlapping matches", () => {
    const text =
      "sk-abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmno";
    const results = detectSecrets(text);
    for (let i = 1; i < results.length; i++) {
      expect(results[i].start).toBeGreaterThanOrEqual(results[i - 1].end);
    }
  });
});
