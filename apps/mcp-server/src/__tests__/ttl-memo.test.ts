import { describe, it, expect, vi } from "vitest";
import { createTtlMemo } from "../utils/ttl-memo.js";

/**
 * The memo behind the admin metrics cache (engram#551). What matters is not
 * the caching itself but the failure shape: when D1 is overloaded the memo
 * must hand back the last good value and stop asking for a while, and when
 * it has nothing to hand back it must fail the way the uncached code did.
 */

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe("createTtlMemo", () => {
  it("computes once within the TTL and again after it", async () => {
    const c = clock();
    let n = 0;
    const memo = createTtlMemo<number>({ ttlMs: 1000, now: c.now });
    const compute = async () => ++n;

    expect(await memo.get(compute)).toBe(1);
    c.advance(999);
    expect(await memo.get(compute)).toBe(1);
    c.advance(1);
    expect(await memo.get(compute)).toBe(2);
    expect(n).toBe(2);
  });

  it("shares one compute between concurrent callers", async () => {
    let n = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const memo = createTtlMemo<number>({ ttlMs: 1000 });
    const compute = async () => {
      n++;
      await gate;
      return n;
    };

    const a = memo.get(compute);
    const b = memo.get(compute);
    const d = memo.get(compute);
    release();
    expect(await Promise.all([a, b, d])).toEqual([1, 1, 1]);
    expect(n).toBe(1);
  });

  it("serves the last good value when a recompute throws, and backs off before retrying", async () => {
    const c = clock();
    const onStale = vi.fn();
    const memo = createTtlMemo<string>({ ttlMs: 1000, errorBackoffMs: 500, now: c.now, onStale });
    expect(await memo.get(async () => "good")).toBe("good");

    c.advance(1000);
    let attempts = 0;
    const failing = async (): Promise<string> => {
      attempts++;
      throw new Error("D1_ERROR: Requests queued for too long");
    };
    expect(await memo.get(failing)).toBe("good");
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onStale.mock.calls[0][1]).toBe(1000); // age of what was served

    // Inside the backoff: served again without another attempt.
    c.advance(499);
    expect(await memo.get(failing)).toBe("good");
    expect(attempts).toBe(1);

    // Past it: tried again, and a success replaces the stale value.
    c.advance(1);
    expect(await memo.get(async () => "fresh")).toBe("fresh");
    expect(memo.peek()?.fresh).toBe(true);
  });

  it("propagates the error when there is nothing to fall back on, and does not cache it", async () => {
    const memo = createTtlMemo<number>({ ttlMs: 1000, errorBackoffMs: 500 });
    await expect(
      memo.get(async () => {
        throw new Error("cold");
      }),
    ).rejects.toThrow("cold");
    expect(await memo.get(async () => 7)).toBe(7);
  });

  it("peek reports age and freshness without computing; reset forgets", async () => {
    const c = clock();
    const memo = createTtlMemo<number>({ ttlMs: 100, now: c.now });
    expect(memo.peek()).toBeNull();
    await memo.get(async () => 1);
    c.advance(150);
    expect(memo.peek()).toEqual({ value: 1, ageMs: 150, fresh: false });
    memo.reset();
    expect(memo.peek()).toBeNull();
  });
});
