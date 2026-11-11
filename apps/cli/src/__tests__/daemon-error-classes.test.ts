import { describe, it, expect } from "vitest";
import { AuthenticationError, EngramError, NotFoundError, TimeoutError } from "@getengram/sdk";
import { classifyError, isNotFound, syncErrorSummary } from "../daemon/status.js";

// engram#587: the daemon read every failure by searching the error's text
// for "401", "429", "rate"…, and the SDK's errors don't read like that.
// These are the errors the SDK actually throws (packages/sdk/src/transport.ts)
// for what the server actually sends.

/** A tool's refusal (isError): the tool's JSON body is the message. */
const refusal = (body: object) => new EngramError(JSON.stringify(body));

/** An HTTP error whose JSON body has a string `error` (the rate limiter,
 *  a 5xx): empty message, code "undefined", and the status. */
const httpError = (status: number) => new EngramError("", "undefined", status);

describe("classifyError reads the error's structure first", () => {
  it("a rejected key is auth: the SDK's AuthenticationError has no digits", () => {
    expect(classifyError(new AuthenticationError())).toBe("auth");
    expect(classifyError(new EngramError("", "auth_error"))).toBe("auth");
    expect(classifyError(httpError(401))).toBe("auth");
    expect(classifyError(httpError(403))).toBe("auth");
  });

  it("a key without a scope is auth", () => {
    expect(
      classifyError(refusal({ error: "insufficient_scope", required: "write", message: "No scope." })),
    ).toBe("auth");
  });

  it("a rate limit is rate_limit, though the SDK gives it no message", () => {
    expect(classifyError(httpError(429))).toBe("rate_limit");
    expect(classifyError(refusal({ error: "rate_limit_exceeded", message: "Slow down.", retry_after: 60 }))).toBe(
      "rate_limit",
    );
  });

  it("every limit and quota refusal is billing, whatever its usage count", () => {
    for (const used of [401, 403, 429, 503, 1403]) {
      for (const error of ["indexing_quota_exceeded", "message_limit_exceeded", "search_quota_exceeded"]) {
        expect(classifyError(refusal({ error, message: "Limit reached.", limit: 5000, used }))).toBe("billing");
      }
    }
    expect(classifyError(httpError(402))).toBe("billing");
  });

  it("the server's code wins over the words of its message", () => {
    // Read as text, "too many requests" would make this a rate limit and
    // retry it every 2 s; the code says it's the plan's monthly limit.
    expect(
      classifyError(refusal({ error: "message_limit_exceeded", message: "Too many requests this month." })),
    ).toBe("billing");
  });

  it("a full memory is storage_full, whatever its usage count", () => {
    expect(classifyError(refusal({ error: "storage_full", message: "Full.", limit: 401, used: 401 }))).toBe(
      "storage_full",
    );
  });

  it("a full memory is storage_full, even in text that also reads as a refusal for size", () => {
    // Waiting, or sending in halves, can never clear a full memory: it needs
    // the user. So it wins over a 413's words wherever a text has both.
    expect(classifyError("413 storage_full")).toBe("storage_full");
    expect(classifyError("Payload Too Large: storage_full")).toBe("storage_full");
  });

  it("a maintenance pause is paused, its own kind (engram#596)", () => {
    // It passes on its own and holds the whole account, unlike an error on
    // the server's side, which holds one conversation.
    expect(classifyError(refusal({ error: "writes_paused", message: "Paused for maintenance." }))).toBe("paused");
  });

  it("the server's own code wins over the HTTP status", () => {
    // Maintenance is a 503 carrying writes_paused; a refusal body sent with
    // an auth-looking status is still the refusal it names.
    expect(classifyError(new EngramError(JSON.stringify({ error: "writes_paused" }), "undefined", 503))).toBe(
      "paused",
    );
    expect(classifyError(new EngramError(JSON.stringify({ error: "storage_full" }), "undefined", 500))).toBe(
      "storage_full",
    );
  });

  it("a 5xx is server", () => {
    expect(classifyError(httpError(500))).toBe("server");
    expect(classifyError(httpError(503))).toBe("server");
  });

  it("a request refused as too large is too_large, however the refusal arrives (engram#750)", () => {
    // Engram's own limit answers in plain text, not JSON-RPC, so the SDK
    // throws "Unexpected response format" with no status. Before: a network
    // error, and the same oversized batch was sent again forever.
    expect(classifyError(new EngramError("Unexpected response format: Payload Too Large"))).toBe("too_large");
    // A proxy in front of Engram answers with its own page.
    expect(
      classifyError(
        new EngramError(
          "Unexpected response format: <html>\r\n<head><title>413 Request Entity Too Large</title></head>",
        ),
      ),
    ).toBe("too_large");
    // RFC 9110's name for it, and the status when an error carries one.
    expect(classifyError("413 Content Too Large")).toBe("too_large");
    expect(classifyError(httpError(413))).toBe("too_large");
    // Each way of saying it counts alone: a page may give the reason
    // without the number, or the number without the reason.
    expect(classifyError(new EngramError("Unexpected response format: Request Entity Too Large"))).toBe(
      "too_large",
    );
    expect(classifyError(new EngramError("Unexpected response format: Content Too Large"))).toBe("too_large");
    expect(classifyError(new Error("Request failed with status 413"))).toBe("too_large");
  });

  it("a number that only contains 413 is not a refusal for size", () => {
    expect(classifyError(new Error("fetch failed after 4130 ms"))).toBe("network");
    expect(classifyError(new Error("connection reset (code 14135)"))).toBe("network");
  });

  it("a 413 inside a JSON body is data, not a refusal for size", () => {
    expect(classifyError(refusal({ error: "something_new", used: 413 }))).toBe("network");
    expect(classifyError(refusal({ error: { code: 413 } }))).toBe("network");
    expect(classifyError(new EngramError(JSON.stringify({ error: "storage_full" }), "undefined", 413))).toBe(
      "storage_full",
    );
  });

  it("says a refusal for size keeps the message queued, in order", () => {
    const summary = syncErrorSummary("too_large");
    expect(summary).toMatch(/too large/);
    expect(summary).toMatch(/stays queued here, in order/);
    expect(summary).toMatch(/Nothing is lost\./);
  });

  it("network failures and timeouts are network", () => {
    expect(classifyError(new EngramError("Network error: fetch failed"))).toBe("network");
    expect(classifyError(new EngramError("Network error: getaddrinfo ENOTFOUND mcp.getengram.app"))).toBe("network");
    expect(classifyError(new TimeoutError())).toBe("network");
    expect(classifyError(new EngramError("Empty response from server"))).toBe("network");
  });

  it("'rate' inside another word is not a rate limit", () => {
    expect(classifyError(new EngramError("Failed to generate embeddings"))).toBe("network");
    expect(classifyError(new EngramError("Could not separate the batch"))).toBe("network");
  });

  it("a number inside a JSON body is never read as a status", () => {
    // A tool refusal the classifier doesn't know, carrying digits that look
    // like statuses. Before: the "403" read as a rejected key and stopped
    // syncing until a restart.
    expect(classifyError(refusal({ error: "something_new", used: 403, limit: 401, retry: 429 }))).toBe("network");
    expect(classifyError(refusal({ error: { code: 42 }, used: 403 }))).toBe("network");
  });

  it("plain text from older servers still classifies", () => {
    expect(classifyError("401 Unauthorized")).toBe("auth");
    expect(classifyError("Forbidden")).toBe("auth");
    expect(classifyError("Invalid or missing API key")).toBe("auth");
    expect(classifyError("Request failed with 402")).toBe("billing");
    expect(classifyError("429 too many requests")).toBe("rate_limit");
    expect(classifyError("503 service unavailable")).toBe("server");
    expect(classifyError(`402 ${JSON.stringify({ error: "storage_full" })}`)).toBe("storage_full");
  });

  it("anything else is network", () => {
    expect(classifyError(undefined)).toBe("network");
    expect(classifyError(null)).toBe("network");
    expect(classifyError(42)).toBe("network");
    expect(classifyError({})).toBe("network");
  });
});

describe("isNotFound trusts only Engram's own answer", () => {
  it("accepts the delete tool's 'Conversation not found'", () => {
    expect(isNotFound(refusal({ error: "Conversation not found" }))).toBe(true);
    expect(isNotFound(new EngramError("Conversation not found."))).toBe(true);
  });

  it("rejects a DNS failure: ENOTFOUND is not 'not found'", () => {
    expect(isNotFound(new EngramError("Network error: getaddrinfo ENOTFOUND mcp.getengram.app"))).toBe(false);
  });

  it("rejects anything that came with an HTTP status", () => {
    // Engram answers a missing conversation as a tool result, never with an
    // HTTP status. The SDK never throws NotFoundError; another service at
    // the wrong URL can send a 404 with any body.
    expect(isNotFound(new NotFoundError())).toBe(false);
    expect(isNotFound(new EngramError("Not Found", "not_found", 404))).toBe(false);
    expect(isNotFound(new EngramError("Conversation not found", "undefined", 200))).toBe(false);
    expect(isNotFound(httpError(404))).toBe(false);
  });

  it("rejects text that only mentions not found", () => {
    expect(isNotFound(new EngramError("Unexpected response format: <html>404 Not Found</html>"))).toBe(false);
    expect(isNotFound(refusal({ error: "Message not found" }))).toBe(false);
    expect(isNotFound(refusal({ error: { code: "not_found" } }))).toBe(false);
    expect(isNotFound(new EngramError("Conversation not found; also the database is gone"))).toBe(false);
  });
});
