import { describe, it, expect } from "vitest";
import { TIER_LIMITS } from "@getengram/shared";
import { storageLimitFor } from "../services/tier.js";
import {
  usageMeter,
  storageFullMessage,
  approachingStorageNotice,
} from "../mcp/usage-messaging.js";

describe("storage cap tiers (engram#275)", () => {
  it("free is gated on storage, not monthly velocity", () => {
    expect(TIER_LIMITS.free.storage_messages).toBe(10_000);
    expect(TIER_LIMITS.free.messages_per_month).toBe(-1);
  });

  it("paid tiers keep a monthly abuse guard but sell storage", () => {
    expect(TIER_LIMITS.pro.storage_messages).toBe(1_000_000);
    expect(TIER_LIMITS.pro.messages_per_month).toBe(100_000);
    expect(TIER_LIMITS.enterprise.storage_messages).toBe(-1);
  });

  it("team storage pools per seat", () => {
    expect(storageLimitFor("team", 1)).toBe(1_000_000);
    expect(storageLimitFor("team", 5)).toBe(5_000_000);
    expect(storageLimitFor("team", null)).toBe(1_000_000);
    expect(storageLimitFor("team", 0)).toBe(1_000_000);
  });

  it("non-team tiers ignore seats; unlimited passes through", () => {
    expect(storageLimitFor("free", 5)).toBe(10_000);
    expect(storageLimitFor("pro", 5)).toBe(1_000_000);
    expect(storageLimitFor("enterprise", 5)).toBe(-1);
  });
});

describe("storage messaging", () => {
  it("memory-full copy is warm, mentions safety, dashboard for OAuth", () => {
    const m = storageFullMessage({ limit: 10_000, isOAuth: true });
    expect(m).toContain("10,000");
    expect(m).toMatch(/memory is full/i);
    expect(m).toMatch(/never expires|safe/i);
    expect(m).toContain("getengram.app/dashboard");
    expect(m).toMatch(/delete old conversations/i);
    expect(m).toMatch(/don't try to collect payment/i);
  });

  it("memory-full copy points API callers at pricing", () => {
    const m = storageFullMessage({ limit: 10_000, isOAuth: false });
    expect(m).toContain("getengram.app/pricing");
    expect(m).toMatch(/delete old conversations/i);
  });

  it("80% warning fires at the right threshold", () => {
    expect(
      approachingStorageNotice(usageMeter(8_000, 10_000), false),
    ).toMatch(/8,000\/10,000/);
    expect(
      approachingStorageNotice(usageMeter(7_999, 10_000), false),
    ).toBeUndefined();
    expect(approachingStorageNotice(undefined, false)).toBeUndefined();
  });

  it("80% warning routes OAuth users to their dashboard", () => {
    expect(
      approachingStorageNotice(usageMeter(9_500, 10_000), true),
    ).toMatch(/dashboard/);
  });
});
