import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HTTPException } from "hono/http-exception";
import { isTransientD1Error } from "../services/resilient-d1.js";

/**
 * Tool failure policy (engram#513).
 *
 * The SDK's CallTool handler catches whatever a tool throws and hands the
 * caller `error.message` verbatim as `isError` content. For a D1 failure
 * that is a table name, a constraint, or a statement fragment — exactly the
 * text app.onError (engram#458) was written never to disclose — and the
 * connected AI client usually repeats it to the person on the other side.
 * This installs the REST layer's policy at the tool layer:
 *
 * - HTTPException: a deliberate, user-facing failure (the 404 for a missing
 *   conversation, the 503 of the maintenance freeze), written for the
 *   caller. A JSON body with a string `error` code passes through verbatim,
 *   the same body app.onError answers REST with, so a client branches on
 *   one code whichever surface it used (engram#592: the CLI daemon reads
 *   `conversation_not_found` and `writes_paused` from it). Otherwise the
 *   exception's message, and never an empty string: an empty failure reads
 *   as "unknown error", which a client can only retry.
 * - McpError: protocol semantics belong to the SDK (a URL elicitation must
 *   propagate as a JSON-RPC error, anything else keeps its code prefix), so
 *   it is rethrown untouched.
 * - Transient D1 pressure, judged by the predicate app.onError and the retry
 *   layer share: a retry hint, never the D1 text.
 * - Anything else: logged server-side with the tool name and a short
 *   reference, answered with a generic failure that quotes the reference so
 *   a support thread can find the log line.
 *
 * Installed once, on the McpServer instance, by wrapping `registerTool` and
 * `tool`: every tool registered through that server is covered without each
 * tool file knowing. createMcpServer is the only place a McpServer is built
 * (tool-error-policy.test.ts pins that), so nothing registers around it.
 */

export const SUPPORT_EMAIL = "hello@getengram.app";

type ToolLog = Pick<Console, "error" | "warn">;
type AnyToolCallback = (...args: unknown[]) => unknown;

/** Eight hex characters: enough to find one log line, not an identifier of anything. */
function shortRef(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

function failure(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Longest HTTPException body passed through; anything longer is not a code-bearing error body. */
const MAX_PASSTHROUGH_BODY_CHARS = 2000;

/**
 * The exception's response body, when it is the JSON error shape the REST
 * layer answers with (`{"error": "<code>", ...}`); otherwise null. Reads a
 * clone, so the response itself stays readable, and treats a body that can't
 * be read or parsed as absent rather than failing the failure path.
 */
async function errorBody(err: HTTPException): Promise<string | null> {
  if (!err.res) return null;
  try {
    const text = await err.res.clone().text();
    if (text.length === 0 || text.length > MAX_PASSTHROUGH_BODY_CHARS) return null;
    const parsed: unknown = JSON.parse(text);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as { error?: unknown }).error === "string"
    ) {
      return text;
    }
    return null;
  } catch {
    return null;
  }
}

async function httpFailureText(name: string, err: HTTPException): Promise<string> {
  const body = await errorBody(err);
  if (body !== null) return body;
  if (err.message) return err.message;
  return `The ${name} tool was refused (HTTP ${err.status}) and did not complete.`;
}

/**
 * Map a value a tool threw to the result the caller may see, logging what
 * they may not. Rethrows an McpError (the SDK owns that path). Exported so
 * the policy can be tested without a server; createMcpServer wires it in
 * through guardToolErrors.
 */
export async function toolFailureResult(
  name: string,
  err: unknown,
  log: ToolLog = console,
): Promise<CallToolResult> {
  if (err instanceof McpError) throw err;
  if (err instanceof HTTPException) return failure(await httpFailureText(name, err));

  const ref = shortRef();
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  if (isTransientD1Error(err)) {
    log.warn(`[tool ${name}] transient storage pressure (ref ${ref}): ${detail}`);
    return failure(
      `The ${name} tool could not complete because Engram's storage is briefly overloaded (ref ${ref}). Retry in a few seconds.`,
    );
  }
  log.error(`[tool ${name}] failed (ref ${ref}): ${detail}`);
  return failure(
    `The ${name} tool failed with an internal error and did not complete (ref ${ref}). Retrying may help; if it keeps failing, contact ${SUPPORT_EMAIL} and quote the ref.`,
  );
}

function guarded(name: string, cb: AnyToolCallback, log: ToolLog): AnyToolCallback {
  // Spread keeps the SDK's two calling conventions intact: (args, extra) for
  // a tool with an input schema, (extra) for one without.
  return async (...args: unknown[]) => {
    try {
      return await cb(...args);
    } catch (err) {
      return await toolFailureResult(name, err, log);
    }
  };
}

/**
 * Wrap this server's `registerTool` and `tool` so every callback registered
 * afterwards runs under the failure policy. Returns the same instance.
 */
export function guardToolErrors(server: McpServer, log: ToolLog = console): McpServer {
  const registerTool = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  const tool = server.tool.bind(server) as (...args: unknown[]) => unknown;

  // registerTool(name, config, callback). A task handler object (SDK 1.32
  // `createTask`) is not a function; nothing here registers one, and it is
  // passed through untouched rather than mis-wrapped.
  server.registerTool = ((name: string, config: unknown, cb: unknown) =>
    registerTool(
      name,
      config,
      typeof cb === "function" ? guarded(name, cb as AnyToolCallback, log) : cb,
    )) as unknown as McpServer["registerTool"];

  // tool() is variadic; the callback is always the last argument.
  server.tool = ((name: string, ...rest: unknown[]) => {
    const cb = rest[rest.length - 1];
    if (typeof cb === "function") rest[rest.length - 1] = guarded(name, cb as AnyToolCallback, log);
    return tool(name, ...rest);
  }) as unknown as McpServer["tool"];

  return server;
}
