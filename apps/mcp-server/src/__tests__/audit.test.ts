import { describe, it, expect } from "vitest";
import { audit } from "../services/audit.js";

// Regression coverage for the "unawaited audit() gets killed by the Workers
// runtime" bug: production showed 0 'search' audit rows ever recorded and
// only 4 'messages.append' despite hundreds of real calls, while
// 'conversation.read'/'conversation.list' (whose handlers await other work
// first) mostly survived — a stateless /mcp transport with no ctx.waitUntil
// wiring simply tears down fire-and-forget writes once the response is
// returned. audit() must be a real awaitable that callers block on.

function fakeDb(run: () => Promise<unknown>) {
  return {
    prepare: () => ({
      bind: () => ({ run }),
    }),
  } as unknown as D1Database;
}

describe("audit()", () => {
  it("does not resolve until the underlying D1 write completes", async () => {
    let resolveWrite!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    let wrote = false;
    const db = fakeDb(async () => {
      await writeStarted;
      wrote = true;
      return { results: [], success: true, meta: {} };
    });

    const auditPromise = audit(db, "org_1", null, "search");

    // Let pending microtasks flush; the write hasn't been unblocked yet, so
    // audit() must still be pending — this is what "await audit(...)"
    // callers now correctly depend on.
    await Promise.resolve();
    await Promise.resolve();
    expect(wrote).toBe(false);

    resolveWrite();
    await auditPromise;
    expect(wrote).toBe(true);
  });

  it("never throws, even when the underlying write fails", async () => {
    const db = fakeDb(async () => {
      throw new Error("D1 write failed");
    });

    await expect(
      audit(db, "org_1", null, "search"),
    ).resolves.toBeUndefined();
  });
});
