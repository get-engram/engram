import { describe, it, expect } from "vitest";
import {
  usageMeter,
  limitMessage,
  approachingLimitNotice,
} from "../mcp/usage-messaging.js";

describe("usageMeter", () => {
  it("computes remaining for limited tiers", () => {
    expect(usageMeter(950, 1000)).toEqual({ used: 950, limit: 1000, remaining: 50 });
  });
  it("clamps remaining at 0", () => {
    expect(usageMeter(1200, 1000)?.remaining).toBe(0);
  });
  it("returns undefined for unlimited / missing data", () => {
    expect(usageMeter(5, -1)).toBeUndefined();
    expect(usageMeter(undefined, 1000)).toBeUndefined();
    expect(usageMeter(5, undefined)).toBeUndefined();
  });
});

describe("limitMessage", () => {
  it("routes OAuth users to their own dashboard, not a sale", () => {
    const m = limitMessage({ unit: "messages", tier: "free", limit: 1000, used: 1000, isOAuth: true });
    expect(m).toContain("getengram.app/dashboard");
    expect(m).toMatch(/sign in/i);
    expect(m).toMatch(/don't try to collect payment/i);
  });
  it("points API-key users to pricing", () => {
    const m = limitMessage({ unit: "messages", tier: "free", limit: 1000, used: 1000, isOAuth: false });
    expect(m).toContain("getengram.app/pricing");
    expect(m).toContain("1000");
  });
});

describe("approachingLimitNotice", () => {
  it("warns at/above 80% usage", () => {
    expect(approachingLimitNotice({ used: 800, limit: 1000, remaining: 200 }, true)).toMatch(/dashboard/);
    expect(approachingLimitNotice({ used: 950, limit: 1000, remaining: 50 }, false)).toMatch(/pricing/);
  });
  it("stays quiet below 80%", () => {
    expect(approachingLimitNotice({ used: 500, limit: 1000, remaining: 500 }, true)).toBeUndefined();
  });
  it("no notice for unlimited / undefined", () => {
    expect(approachingLimitNotice(undefined, true)).toBeUndefined();
    expect(approachingLimitNotice({ used: 1, limit: 0, remaining: 0 }, true)).toBeUndefined();
  });
});
