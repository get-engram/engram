import { describe, it, expect, beforeAll } from "vitest";
import app from "../index.js";
import { hashApiKey, generateApiKeyRaw, generateId } from "@getengram/shared";
import { createMockD1, createMockEnv } from "./helpers.js";

let testApiKey: string;
let mockEnv: ReturnType<typeof createMockEnv>;

beforeAll(async () => {
  const db = createMockD1();
  mockEnv = createMockEnv(db);

  // Seed org + API key
  const { raw, prefix } = generateApiKeyRaw();
  testApiKey = raw;
  const keyHash = await hashApiKey(raw);
  const keyId = generateId("key");
  const orgId = "org_authtest";

  await db.exec(`
    INSERT INTO organizations (id, name) VALUES ('${orgId}', 'Auth Org');
    INSERT INTO api_keys (id, organization_id, key_hash, key_prefix, name) VALUES ('${keyId}', '${orgId}', '${keyHash}', '${prefix}', 'test');
  `);
});

describe("Auth middleware", () => {
  it("rejects requests without Authorization header", async () => {
    const response = await app.fetch(
      new Request("http://localhost/mcp", { method: "POST" }),
      mockEnv
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("Authorization");
  });

  it("rejects requests with Basic auth instead of Bearer", async () => {
    const response = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { Authorization: "Basic abc123" },
      }),
      mockEnv
    );
    expect(response.status).toBe(401);
  });

  it("rejects requests with wrong key prefix", async () => {
    const response = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer sk_live_wrongformat" },
      }),
      mockEnv
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("format");
  });

  it("rejects requests with nonexistent API key", async () => {
    const response = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          Authorization:
            "Bearer engram_sk_live_00000000000000000000000000000000",
        },
      }),
      mockEnv
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("Invalid API key");
  });

  it("accepts valid API key and passes auth", async () => {
    const response = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${testApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "0.1.0" },
          },
        }),
      }),
      mockEnv,
      { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext
    );
    // Should not be 401 — auth passed
    expect(response.status).not.toBe(401);
  });
});
