import { describe, it, expect } from "vitest";
import { RETRY_BASE_MS, RETRY_CAP_MS, formatWait, retryDelay } from "../daemon/backoff.js";

// engram#596: how long the daemon waits before trying again what failed in
// a way that passes on its own. The wait doubles with each failure in a
// row and is drawn at random between half and all of that.

/** The lowest and highest draws Math.random can make. */
const lowest = () => 0;
const highest = () => 1 - 1e-9;

describe("retryDelay", () => {
  it("doubles from 5 s with each failure in a row, up to 5 minutes", () => {
    const longest = [1, 2, 3, 4, 5, 6, 7, 8, 20].map((n) => retryDelay(n, highest));
    expect(longest).toEqual([
      5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000,
    ]);
    expect(RETRY_BASE_MS).toBe(5_000);
    expect(RETRY_CAP_MS).toBe(300_000);
  });

  it("draws each wait between half and all of its longest", () => {
    for (let n = 1; n <= 10; n++) {
      const top = retryDelay(n, highest);
      expect(retryDelay(n, lowest)).toBe(top / 2);
      for (const r of [0.1, 0.25, 0.5, 0.75, 0.9]) {
        const wait = retryDelay(n, () => r);
        expect(wait).toBeGreaterThanOrEqual(top / 2);
        expect(wait).toBeLessThanOrEqual(top);
      }
    }
  });

  it("uses Math.random by default, so daemons refused together come back spread out", () => {
    const waits = new Set(Array.from({ length: 50 }, () => retryDelay(3)));
    for (const wait of waits) {
      expect(wait).toBeGreaterThanOrEqual(10_000);
      expect(wait).toBeLessThanOrEqual(20_000);
    }
    expect(waits.size).toBeGreaterThan(10);
  });

  it("until the cap, a wait is never shorter than the one before it", () => {
    for (let n = 1; retryDelay(n + 1, highest) < RETRY_CAP_MS; n++) {
      expect(retryDelay(n + 1, lowest)).toBeGreaterThanOrEqual(retryDelay(n, highest));
    }
  });

  it("treats a count below 1 as the first failure, and a huge one as the cap", () => {
    expect(retryDelay(0, highest)).toBe(5_000);
    expect(retryDelay(-3, highest)).toBe(5_000);
    expect(retryDelay(1_000_000, highest)).toBe(RETRY_CAP_MS);
    expect(retryDelay(Number.MAX_SAFE_INTEGER, lowest)).toBe(RETRY_CAP_MS / 2);
  });
});

describe("formatWait", () => {
  it.each([
    [0, "1s"],
    [-500, "1s"],
    [1, "1s"],
    [1_000, "1s"],
    [1_001, "2s"],
    [4_200, "5s"],
    [59_000, "59s"],
    [59_001, "1m"],
    [60_000, "1m"],
    [90_000, "1m 30s"],
    [150_000, "2m 30s"],
    [300_000, "5m"],
  ])("%i ms reads %s", (ms, words) => {
    expect(formatWait(ms)).toBe(words);
  });
});
