import { describe, it, expect } from "vitest";
import { classifyError, syncErrorSummary } from "../daemon/status.js";
import { parseStorageFullError } from "../storage-error.js";

/**
 * A full memory used to be indistinguishable from any other 402 inside the
 * daemon: classified as "billing", logged once to daemon.log, then retried
 * on a backoff forever. Nothing reached the user, and captures kept piling
 * into a local queue that could never drain.
 */
describe("storage_full classification", () => {
  const body = JSON.stringify({
    error: "storage_full",
    message: "Engram's memory is full (10,000 messages).",
    used: 10000,
    limit: 10000,
  });

  it("classifies a storage_full body distinctly from other billing errors", () => {
    expect(classifyError(body)).toBe("storage_full");
  });

  it("still classifies ordinary quota errors as billing", () => {
    expect(classifyError('{"error":"limit_exceeded","message":"x"}')).toBe("billing");
    expect(classifyError("Request failed with 402")).toBe("billing");
  });

  it("does not let the generic 402 branch shadow storage_full", () => {
    // The real payload carries both markers; order of checks decides.
    expect(classifyError(`402 ${body}`)).toBe("storage_full");
  });

  it("leaves other error classes alone", () => {
    expect(classifyError("Authentication failed")).toBe("auth");
    expect(classifyError("429 too many requests")).toBe("rate_limit");
    expect(classifyError("503 service unavailable")).toBe("server");
    expect(classifyError("fetch failed")).toBe("network");
  });
});

describe("syncErrorSummary", () => {
  it("names the actual numbers when they are known", () => {
    const msg = syncErrorSummary("storage_full", { used: 10000, limit: 10000 });
    expect(msg).toContain("10,000/10,000");
    expect(msg).toContain("getengram.app/pricing");
  });

  it("says new captures will NOT be saved — the part users need", () => {
    const msg = syncErrorSummary("storage_full", { used: 10000, limit: 10000 });
    expect(msg).toMatch(/not be saved/i);
  });

  it("degrades without numbers rather than printing undefined", () => {
    const msg = syncErrorSummary("storage_full", null);
    expect(msg).not.toContain("undefined");
    expect(msg).toContain("full");
  });

  it("distinguishes a full memory from a generic plan limit", () => {
    const full = syncErrorSummary("storage_full", { used: 10000, limit: 10000 });
    const billing = syncErrorSummary("billing", null);
    expect(full).not.toBe(billing);
    // Retrying clears a rate limit; it can never clear a full memory, so the
    // copy must not imply waiting is a fix.
    expect(full).not.toMatch(/retry|backoff/i);
    expect(billing).toMatch(/retry/i);
  });

  it("covers every error type without falling through to undefined", () => {
    for (const t of ["auth", "storage_full", "billing", "rate_limit", "network", "server"] as const) {
      const msg = syncErrorSummary(t, null);
      expect(msg.length).toBeGreaterThan(10);
      expect(msg).not.toContain("undefined");
    }
  });
});

describe("parseStorageFullError (shared module)", () => {
  it("round-trips the server payload", () => {
    expect(
      parseStorageFullError(
        JSON.stringify({ error: "storage_full", message: "full", used: 10000, limit: 10000 }),
      ),
    ).toEqual({ message: "full", used: 10000, limit: 10000, upgrade_url: undefined });
  });

  it("returns null for other errors and for junk", () => {
    expect(parseStorageFullError('{"error":"limit_exceeded"}')).toBeNull();
    expect(parseStorageFullError("not json")).toBeNull();
    expect(parseStorageFullError("")).toBeNull();
  });
});
