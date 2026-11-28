import { describe, it, expect } from "vitest";
import { takeToken } from "../middleware/ip-throttle.js";

// The buckets are module-global and live for this whole file: every test
// uses keys of its own and passes its own clock.

describe("takeToken", () => {
  it("refuses an empty bucket and refills it continuously", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) expect(takeToken("t:refill", 5, 60_000, t0)).toBe(true);
    expect(takeToken("t:refill", 5, 60_000, t0)).toBe(false);
    // One token comes back every windowMs / limit.
    expect(takeToken("t:refill", 5, 60_000, t0 + 12_000)).toBe(true);
    expect(takeToken("t:refill", 5, 60_000, t0 + 12_000)).toBe(false);
  });

  it("a sweep drops only buckets idle for their OWN window", () => {
    const t0 = 2_000_000;
    // Spend a 15-minute bucket.
    for (let i = 0; i < 5; i++) expect(takeToken("t:long", 5, 15 * 60_000, t0)).toBe(true);
    // Fill the map past the sweep threshold with 60-second buckets.
    for (let i = 0; i < 20_000; i++) takeToken(`t:short:${i}`, 10, 60_000, t0);
    // Two minutes later a 60-second caller sweeps the idle 60-second buckets...
    expect(takeToken("t:trigger", 10, 60_000, t0 + 120_000)).toBe(true);
    // ...but the 15-minute bucket stays spent: 2 minutes refill 0.67 of a token.
    expect(takeToken("t:long", 5, 15 * 60_000, t0 + 120_000)).toBe(false);
  });
});
