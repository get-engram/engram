import { describe, it, expect } from "vitest";
import { checkMilestone } from "../services/milestones.js";
import { unsubscribeSig } from "../cron/weekly-digest.js";
import { createMockD1, createMockEnv } from "./helpers.js";
import type { Env } from "../types.js";

describe("checkMilestone (engram#256)", () => {
  it("returns nothing below the first threshold", async () => {
    const env = createMockEnv(createMockD1()) as unknown as Env;
    expect(await checkMilestone(env, "org_m", 99)).toBeUndefined();
    expect(await checkMilestone(env, "org_m", 0)).toBeUndefined();
    expect(await checkMilestone(env, "org_m", undefined)).toBeUndefined();
  });

  it("announces the highest crossed threshold", async () => {
    const env = createMockEnv(createMockD1()) as unknown as Env;
    const msg = await checkMilestone(env, "org_m", 12_500);
    expect(msg).toContain("10,000");
  });

  it("announces the first threshold exactly at the boundary", async () => {
    const env = createMockEnv(createMockD1()) as unknown as Env;
    const msg = await checkMilestone(env, "org_m", 100);
    expect(msg).toContain("100");
  });
});

describe("unsubscribeSig", () => {
  it("is deterministic and secret-dependent", async () => {
    const a = await unsubscribeSig("org_1", "secret-a");
    const b = await unsubscribeSig("org_1", "secret-a");
    const c = await unsubscribeSig("org_1", "secret-b");
    const d = await unsubscribeSig("org_2", "secret-a");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
