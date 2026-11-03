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
  // Connector copy used to carry a dashboard URL and a scripted instruction
  // ("tell the user, warmly…", "don't try to collect payment here"). Both app
  // directories rejected that in Sept 2026 — Anthropic noted an instruction in
  // a tool output is still an instruction — so connector copy is now factual
  // only: state the account's situation, name no URL, direct nobody.
  it("states the limit factually for OAuth, with no URL or directive", () => {
    const m = limitMessage({ unit: "messages", tier: "free", limit: 1000, used: 1000, isOAuth: true });
    expect(m).toMatch(/limit reached/i);
    expect(m).toContain("1000");
    expect(m).toMatch(/free plan/i);
    expect(m).not.toMatch(/https?:\/\/|getengram\.app/i);
    expect(m).not.toMatch(/tell the user|warmly|don'?t try to collect/i);
  });
  it("points API-key users to key login", () => {
    const m = limitMessage({ unit: "messages", tier: "free", limit: 1000, used: 1000, isOAuth: false });
    expect(m).toContain("getengram.app/login");
    expect(m).toContain("1000");
  });

  // The cost budgets (engram#445/#451) reuse this copy. Same rules: the
  // connector variant names the budget and the plan, no URL, no directive.
  it("describes the search budget factually for OAuth", () => {
    const m = limitMessage({ unit: "searches", tier: "pro", limit: 500000, used: 500000, isOAuth: true });
    expect(m).toMatch(/limit reached/i);
    expect(m).toContain("500000 searches");
    expect(m).toMatch(/pro plan/i);
    expect(m).toMatch(/stays stored/i);
    expect(m).not.toMatch(/https?:\/\/|getengram\.app/i);
    expect(m).not.toMatch(/tell the user|warmly|don'?t try to collect/i);
  });
  it("describes the indexing budget in chunks, the unit it is charged in", () => {
    const oauth = limitMessage({ unit: "indexing", tier: "free", limit: 100000, used: 100000, isOAuth: true });
    expect(oauth).toContain("100000 indexed chunks");
    expect(oauth).toMatch(/stored and searchable/i);
    expect(oauth).not.toMatch(/https?:\/\/|getengram\.app/i);

    const key = limitMessage({ unit: "indexing", tier: "free", limit: 100000, used: 100000, isOAuth: false });
    expect(key).toMatch(/^Indexing limit reached/);
    expect(key).toContain("100000/100000");
    expect(key).toContain("getengram.app/login");
  });
  it("labels a search limit for API-key users", () => {
    const key = limitMessage({ unit: "searches", tier: "free", limit: 50000, used: 50000, isOAuth: false });
    expect(key).toMatch(/^Search limit reached/);
    expect(key).toContain("getengram.app/login");
  });
});

describe("approachingLimitNotice", () => {
  it("warns at/above 80% usage", () => {
    const oauth = approachingLimitNotice({ used: 800, limit: 1000, remaining: 200 }, true);
    expect(oauth).toContain("800/1000");
    expect(oauth).not.toMatch(/https?:\/\/|getengram\.app/i);
    expect(approachingLimitNotice({ used: 950, limit: 1000, remaining: 50 }, false)).toMatch(/login/);
  });
  it("stays quiet below 80%", () => {
    expect(approachingLimitNotice({ used: 500, limit: 1000, remaining: 500 }, true)).toBeUndefined();
  });
  it("no notice for unlimited / undefined", () => {
    expect(approachingLimitNotice(undefined, true)).toBeUndefined();
    expect(approachingLimitNotice({ used: 1, limit: 0, remaining: 0 }, true)).toBeUndefined();
  });
});
