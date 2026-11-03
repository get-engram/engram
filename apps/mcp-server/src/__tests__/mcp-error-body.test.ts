import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { hashApiKey, generateApiKeyRaw, generateId } from "@getengram/shared";
import { createMockD1, createMockEnv } from "./helpers.js";

// The MCP server factory is replaced with one whose connect() throws whatever
// the test puts in `failure`; auth, rate limiting, metering and the /mcp
// handler's own error path run for real.
const failure = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("../mcp/server.js", () => ({
  createMcpServer: () => ({
    connect: async () => {
      throw failure.current;
    },
  }),
}));

import app from "../index.js";

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext;

const GENERIC = { error: "internal_error", message: "An internal error occurred." };

let apiKey: string;
let env: ReturnType<typeof createMockEnv>;

beforeAll(async () => {
  const db = createMockD1();
  env = createMockEnv(db);
  const { raw, prefix } = generateApiKeyRaw();
  apiKey = raw;
  const keyHash = await hashApiKey(raw);
  await db.exec(`
    INSERT INTO organizations (id, name) VALUES ('org_mcperr', 'MCP Error Org');
    INSERT INTO api_keys (id, organization_id, key_hash, key_prefix, name) VALUES ('${generateId("key")}', 'org_mcperr', '${keyHash}', '${prefix}', 'test');
  `);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function initialize() {
  return app.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      }),
    }),
    env,
    ctx,
  );
}

describe("/mcp transport failures (engram#458)", () => {
  it("logs an unexpected error server-side and answers with the generic body", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    failure.current = new Error("D1_ERROR: no such table: internal_table_name");

    const res = await initialize();
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("internal_table_name");
    expect(text).not.toContain("D1_ERROR");
    expect(JSON.parse(text)).toEqual(GENERIC);

    // The operator still gets the real message.
    expect(
      logged.mock.calls.some((args) => args.join(" ").includes("internal_table_name")),
    ).toBe(true);
    // onError's response passes through the hardening middleware too.
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("turns transient D1 pressure into a 503 with Retry-After", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    failure.current = new Error("D1 DB is overloaded. Requests queued for too long");

    const res = await initialize();
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("2");
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("service_unavailable");
  });

  it("wraps a non-Error throw instead of letting it escape the worker", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    failure.current = "transport exploded";

    const res = await initialize();
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("transport exploded");
    expect(JSON.parse(text)).toEqual(GENERIC);
  });
});
