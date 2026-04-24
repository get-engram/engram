import { describe, it, expect } from "vitest";
import { redact, redactMessages } from "../utils/redact.js";

const R = "[REDACTED]";

describe("redact", () => {
  // --- Provider API keys ---

  it("redacts OpenAI keys", () => {
    const input = "My key is sk-abc123def456ghi789jkl012mno345pqr678";
    const { text, redactionCount } = redact(input);
    expect(text).toBe(`My key is ${R}`);
    expect(redactionCount).toBe(1);
  });

  it("redacts Anthropic keys", () => {
    const { text } = redact("key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
    expect(text).toBe(`key: ${R}`);
  });

  it("redacts AWS access keys", () => {
    const { text } = redact("aws_key = AKIAIOSFODNN7EXAMPLE");
    expect(text).toBe(`aws_key = ${R}`);
  });

  it("redacts GitHub tokens", () => {
    const { text } = redact(
      "here: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl"
    );
    expect(text).toBe(`here: ${R}`);
  });

  it("redacts Stripe keys", () => {
    const { text } = redact("sk_live_abc123def456ghi789jkl");
    expect(text).toBe(R);
  });

  it("redacts Cloudflare keys", () => {
    const { text } = redact(
      "cfk_REDACTED_KEY_REMOVED_FROM_HISTORY_000000000"
    );
    expect(text).toBe(R);
  });

  it("redacts Slack tokens", () => {
    const { text } = redact("xoxb-123456789012-abcdefghij");
    expect(text).toBe(R);
  });

  it("redacts npm tokens", () => {
    const { text } = redact(
      "npm_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789"
    );
    expect(text).toBe(R);
  });

  // --- JWTs ---

  it("redacts JWTs", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const { text, redactionCount } = redact(`Bearer ${jwt}`);
    // Bearer pattern and/or JWT pattern fires
    expect(text).not.toContain("eyJ");
    expect(redactionCount).toBeGreaterThanOrEqual(1);
  });

  // --- Connection strings ---

  it("redacts postgres connection strings", () => {
    const { text } = redact(
      "DATABASE_URL=postgres://user:pass@host.com:5432/dbname"
    );
    expect(text).not.toContain("pass");
    expect(text).not.toContain("host.com");
  });

  it("redacts redis connection strings", () => {
    const { text } = redact("REDIS_URL=redis://default:secret@redis.io:6379");
    expect(text).not.toContain("secret");
  });

  // --- Private keys ---

  it("redacts PEM private keys", () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF2PbnGMh
-----END RSA PRIVATE KEY-----`;
    const { text, redactionCount } = redact(`Here is my key:\n${pem}\nDone.`);
    expect(text).not.toContain("MIIEpAIBAAK");
    expect(redactionCount).toBeGreaterThanOrEqual(1);
  });

  // --- Secret assignments ---

  it("redacts password= assignments", () => {
    const { text } = redact('DB_PASSWORD="SuperSecret123!"');
    expect(text).toBe(R);
  });

  it("redacts api_key= assignments", () => {
    const { text } = redact("api_key=abcd1234efgh5678");
    expect(text).not.toContain("abcd1234");
  });

  it("redacts jwt_secret= assignments", () => {
    const { text } = redact("jwt_secret: my-very-secret-key-here");
    expect(text).not.toContain("my-very-secret");
  });

  // --- PII ---

  it("redacts email addresses", () => {
    const { text } = redact("Contact me at john.doe@example.com please");
    expect(text).toBe(`Contact me at ${R} please`);
  });

  it("redacts SSNs", () => {
    const { text } = redact("SSN: 123-45-6789");
    expect(text).toBe(`SSN: ${R}`);
  });

  it("redacts phone numbers", () => {
    const { text } = redact("Call me at (555) 123-4567");
    expect(text).not.toContain("123-4567");
  });

  it("redacts phone numbers with country code", () => {
    const { text } = redact("Phone: +1-555-123-4567");
    expect(text).not.toContain("555-123-4567");
  });

  // --- Generic high-entropy tokens ---

  it("redacts long hex strings", () => {
    const hex = "a".repeat(40);
    const { text } = redact(`here ${hex} end`);
    expect(text).toBe(`here ${R} end`);
  });

  // --- Multiple patterns ---

  it("redacts multiple secrets in one string", () => {
    const input = [
      "OPENAI_KEY=sk-abc123def456ghi789jkl012mno345pqr678",
      "DB_URL=postgres://user:pass@db.com/prod",
      "email: user@example.com",
    ].join("\n");

    const { text, redactionCount } = redact(input);
    expect(text).not.toContain("sk-abc");
    expect(text).not.toContain("pass");
    expect(text).not.toContain("user@example");
    expect(redactionCount).toBeGreaterThanOrEqual(3);
  });

  // --- Preserves normal text ---

  it("does not redact normal conversation text", () => {
    const input =
      "The user asked about implementing a search feature. I suggested using FTS5 with BM25 ranking.";
    const { text, redactionCount } = redact(input);
    expect(text).toBe(input);
    expect(redactionCount).toBe(0);
  });

  it("does not redact short tokens or normal IDs", () => {
    const input = "conv_abc123 msg_def456 chk_ghi789";
    const { text, redactionCount } = redact(input);
    expect(text).toBe(input);
    expect(redactionCount).toBe(0);
  });

  it("does not redact code examples without real secrets", () => {
    const input = 'const x = 42;\nif (password.length < 8) throw new Error("too short");';
    const { text, redactionCount } = redact(input);
    expect(text).toBe(input);
    expect(redactionCount).toBe(0);
  });
});

describe("redactMessages", () => {
  it("redacts content across multiple messages", () => {
    const messages = [
      { content: "My API key is sk-abc123def456ghi789jkl012mno345pqr678" },
      { content: "Normal message with no secrets" },
      { content: "Password: postgres://user:pass@db.com/prod" },
    ];

    const { messages: result, totalRedactions } = redactMessages(messages);
    expect(result[0].content).not.toContain("sk-abc");
    expect(result[1].content).toBe("Normal message with no secrets");
    expect(result[2].content).not.toContain("pass");
    expect(totalRedactions).toBeGreaterThanOrEqual(2);
  });

  it("preserves other message fields", () => {
    const messages = [
      { content: "sk-abc123def456ghi789jkl012mno345pqr678", role: "user", id: "msg_1" },
    ];

    const { messages: result } = redactMessages(messages);
    expect((result[0] as any).role).toBe("user");
    expect((result[0] as any).id).toBe("msg_1");
  });

  it("returns zero redactions for clean messages", () => {
    const messages = [
      { content: "Hello, how can I help you today?" },
      { content: "I'd like to learn about TypeScript." },
    ];

    const { totalRedactions } = redactMessages(messages);
    expect(totalRedactions).toBe(0);
  });
});
