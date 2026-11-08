import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError, ErrorCode, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { guardToolErrors, toolFailureResult } from "../mcp/tool-guard.js";
import { createMcpServer } from "../mcp/server.js";
import { createMockEnv } from "./helpers.js";
import type { Env, AuthContext } from "../types.js";

/**
 * Tool failure policy (engram#513).
 *
 * Everything here goes through the SDK's real CallTool path — a Client on an
 * in-memory transport — because the leak this closes lives in that path: the
 * SDK's catch hands `error.message` to the caller as isError content. A test
 * that invoked the handler directly would never see it.
 */

const D1_TEXT = "D1_ERROR: no such table: chunks_fts: SQLITE_ERROR";
const INTERNAL_TOKENS = ["chunks_fts", "SQLITE", "D1_ERROR", "no such table"];

function silentLog() {
  return { error: vi.fn(), warn: vi.fn() };
}

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "policy-test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function text(result: unknown): string {
  return (result as CallToolResult).content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("\n");
}

function guardedServer() {
  const log = silentLog();
  const server = new McpServer({ name: "policy-test", version: "0.0.0" });
  guardToolErrors(server, log);
  return { server, log };
}

function expectGeneric(t: string, toolName: string): string {
  for (const token of INTERNAL_TOKENS) expect(t, t).not.toContain(token);
  expect(t).toContain(toolName);
  expect(t).toMatch(/internal error/);
  const ref = t.match(/\(ref ([0-9a-f]{8})\)/)?.[1];
  expect(ref, "the reply quotes a reference").toBeTruthy();
  return ref as string;
}

describe("tool failure policy (engram#513)", () => {
  it("a storage error thrown through registerTool reaches the client as a generic failure, and the log as itself", async () => {
    const { server, log } = guardedServer();
    server.registerTool(
      "boom",
      { description: "throws", inputSchema: { q: z.string() } },
      async () => {
        throw new Error(D1_TEXT);
      },
    );
    const client = await connect(server);
    const res = (await client.callTool({ name: "boom", arguments: { q: "hi" } })) as CallToolResult;

    expect(res.isError).toBe(true);
    const ref = expectGeneric(text(res), "boom");
    expect(log.error).toHaveBeenCalledTimes(1);
    const line = String(log.error.mock.calls[0][0]);
    expect(line).toContain(`[tool boom]`);
    expect(line).toContain(ref);
    expect(line).toContain("chunks_fts");
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("covers the legacy tool() signature with annotations and a no-argument callback", async () => {
    const { server, log } = guardedServer();
    server.tool(
      "legacy",
      "throws",
      {},
      { title: "Legacy", readOnlyHint: true },
      async () => {
        throw new Error(D1_TEXT);
      },
    );
    const client = await connect(server);
    const res = (await client.callTool({ name: "legacy", arguments: {} })) as CallToolResult;
    expect(res.isError).toBe(true);
    expectGeneric(text(res), "legacy");
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it("a tool with an output schema still answers with isError, not an output-validation error on top", async () => {
    const { server } = guardedServer();
    server.registerTool(
      "structured",
      {
        description: "throws",
        inputSchema: { q: z.string() },
        outputSchema: { total: z.number() },
      },
      async () => {
        throw new Error(D1_TEXT);
      },
    );
    const client = await connect(server);
    const res = (await client.callTool({ name: "structured", arguments: { q: "x" } })) as CallToolResult;
    expect(res.isError).toBe(true);
    expectGeneric(text(res), "structured");
    expect(text(res)).not.toContain("Output validation");
  });

  it("transient D1 pressure becomes a retry hint, never the D1 text", async () => {
    const { server, log } = guardedServer();
    server.registerTool("busy", { description: "busy", inputSchema: {} }, async () => {
      throw new Error("D1_ERROR: database is locked: SQLITE_BUSY");
    });
    const client = await connect(server);
    const res = (await client.callTool({ name: "busy", arguments: {} })) as CallToolResult;
    expect(res.isError).toBe(true);
    const t = text(res);
    expect(t).toMatch(/briefly overloaded/);
    expect(t).toMatch(/[Rr]etry/);
    expect(t).not.toContain("locked");
    expect(t).not.toContain("SQLITE");
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("a deliberate HTTPException passes through verbatim and is not logged as a failure", async () => {
    const { server, log } = guardedServer();
    server.registerTool("missing", { description: "404", inputSchema: {} }, async () => {
      throw new HTTPException(404, { message: "Conversation not found" });
    });
    const client = await connect(server);
    const res = (await client.callTool({ name: "missing", arguments: {} })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(text(res)).toBe("Conversation not found");
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("a JSON error body passes through verbatim, so a tool caller reads the code REST callers get (engram#592)", async () => {
    // The shape that answered with an empty string before: a body, no message.
    const { server, log } = guardedServer();
    const body = { error: "conversation_not_found", message: "No such conversation." };
    server.registerTool("gone", { description: "404", inputSchema: {} }, async () => {
      throw new HTTPException(404, { res: Response.json(body, { status: 404 }) });
    });
    const client = await connect(server);
    const res = (await client.callTool({ name: "gone", arguments: {} })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(JSON.parse(text(res))).toEqual(body);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("the code-bearing body wins over the message, and the response stays readable", async () => {
    const message = "Paused for maintenance.";
    const err = new HTTPException(503, {
      message,
      res: new Response(JSON.stringify({ error: "writes_paused", message }), {
        status: 503,
        headers: { "Content-Type": "application/json", "Retry-After": "60" },
      }),
    });
    const res = await toolFailureResult("append_messages", err, silentLog());
    expect(res.isError).toBe(true);
    expect(JSON.parse(text(res))).toEqual({ error: "writes_paused", message });
    // Read through a clone: app.onError could still answer with the original.
    expect(JSON.parse(await err.getResponse().text()).error).toBe("writes_paused");
  });

  it("a body that is not a JSON error object falls back to the message", async () => {
    const cases: Array<[string, Response]> = [
      ["plain text", new Response("Not here", { status: 404 })],
      ["no error code", Response.json({ ok: false }, { status: 404 })],
      ["non-string code", Response.json({ error: 404 }, { status: 404 })],
      ["array", Response.json([{ error: "x" }], { status: 404 })],
      ["oversized", Response.json({ error: "x", pad: "y".repeat(5000) }, { status: 404 })],
      ["empty", new Response("", { status: 404 })],
    ];
    for (const [label, body] of cases) {
      const res = await toolFailureResult(
        "t",
        new HTTPException(404, { message: "Conversation not found", res: body }),
        silentLog(),
      );
      expect(text(res), label).toBe("Conversation not found");
    }
  });

  it("never answers with an empty string: no message and no code-bearing body names the tool and the status", async () => {
    for (const err of [
      new HTTPException(404),
      new HTTPException(409, { res: new Response("", { status: 409 }) }),
      new HTTPException(400, { res: Response.json({ ok: false }, { status: 400 }) }),
    ]) {
      const log = silentLog();
      const res = await toolFailureResult("append_messages", err, log);
      const t = text(res);
      expect(res.isError).toBe(true);
      expect(t.trim().length, `HTTP ${err.status}`).toBeGreaterThan(0);
      expect(t).toContain("append_messages");
      expect(t).toContain(String(err.status));
      expect(log.error).not.toHaveBeenCalled();
    }
  });

  it("an McpError keeps the SDK's own handling", async () => {
    const { server, log } = guardedServer();
    server.registerTool("protocol", { description: "mcp", inputSchema: {} }, async () => {
      throw new McpError(ErrorCode.InvalidParams, "bad arguments");
    });
    const client = await connect(server);
    const res = (await client.callTool({ name: "protocol", arguments: {} })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("bad arguments");
    expect(text(res)).toMatch(/^MCP error -32602/);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("a successful result, its arguments and the request extra are untouched", async () => {
    const { server, log } = guardedServer();
    const seen: unknown[] = [];
    server.registerTool(
      "fine",
      { description: "ok", inputSchema: { q: z.string() }, outputSchema: { echo: z.string() } },
      async (args, extra) => {
        seen.push(args, extra);
        return {
          content: [{ type: "text" as const, text: `echo ${args.q}` }],
          structuredContent: { echo: args.q },
        };
      },
    );
    const client = await connect(server);
    const res = (await client.callTool({ name: "fine", arguments: { q: "hi" } })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    expect(text(res)).toBe("echo hi");
    expect(res.structuredContent).toEqual({ echo: "hi" });
    expect(seen[0]).toEqual({ q: "hi" });
    expect(seen[1]).toMatchObject({ signal: expect.any(AbortSignal) });
    expect(log.error).not.toHaveBeenCalled();
  });

  it("a non-Error throw is handled like any other internal failure", async () => {
    const log = silentLog();
    const res = await toolFailureResult("odd", "a bare string", log);
    expect(res.isError).toBe(true);
    expectGeneric(text(res), "odd");
    expect(String(log.error.mock.calls[0][0])).toContain("a bare string");
  });
});

describe("createMcpServer installs the policy for every tool", () => {
  const auth: AuthContext = {
    organizationId: "org_policy",
    apiKeyId: "key_policy",
    tier: "pro",
    scopes: ["read", "write", "search", "delete"],
    seatId: null,
  };

  // A D1 whose every statement fails with the given message: what a dropped
  // migration or a renamed column looks like from inside a handler.
  function poisonedEnv(message: string): Env {
    const reject = async () => {
      throw new Error(message);
    };
    const stmt: Record<string, unknown> = { first: reject, all: reject, run: reject, raw: reject };
    stmt.bind = () => stmt;
    const db = {
      prepare: () => stmt,
      batch: reject,
      exec: reject,
      dump: reject,
    } as unknown as D1Database;
    return createMockEnv(db) as unknown as Env;
  }

  it("whoami: a schema-level D1 failure is not disclosed", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const env = poisonedEnv("D1_ERROR: no such table: organizations: SQLITE_ERROR");
      const client = await connect(createMcpServer(env, auth));
      const res = (await client.callTool({ name: "whoami", arguments: {} })) as CallToolResult;
      expect(res.isError).toBe(true);
      const t = text(res);
      expect(t).not.toContain("organizations");
      expect(t).not.toContain("SQLITE");
      expectGeneric(t, "whoami");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0][0])).toContain("organizations");
    } finally {
      spy.mockRestore();
    }
  });

  it("list_conversations: sustained D1 pressure is a retry hint", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const env = poisonedEnv("D1_ERROR: D1 DB is overloaded. Too many queries queued (7429)");
      const client = await connect(createMcpServer(env, auth));
      const res = (await client.callTool({ name: "list_conversations", arguments: {} })) as CallToolResult;
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/briefly overloaded/);
      expect(text(res)).not.toContain("7429");
      expect(text(res)).not.toContain("queued");
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("nothing registers around the guard", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = join(here, "..");

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== "__tests__") walk(full, out);
      } else if (/\.(ts|js|mjs)$/.test(entry)) {
        out.push(full);
      }
    }
    return out;
  }

  it("createMcpServer is the only McpServer construction site, and guards before it registers", () => {
    const sites = walk(src)
      .filter((f) => readFileSync(f, "utf8").includes("new McpServer("))
      .map((f) => relative(src, f));
    expect(sites).toEqual(["mcp/server.ts"]);

    const serverTs = readFileSync(join(src, "mcp/server.ts"), "utf8");
    const guardAt = serverTs.indexOf("guardToolErrors(server)");
    const firstRegister = serverTs.search(/\n\s*register[A-Z]\w*\(server/);
    expect(guardAt).toBeGreaterThan(-1);
    expect(firstRegister).toBeGreaterThan(guardAt);
  });
});
