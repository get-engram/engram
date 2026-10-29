import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { PAID_TIERS, PRIORITY_SUPPORT_TIERS, PURCHASABLE_PLANS, isPaidTier, sqlTierList, type Tier } from "@getengram/shared";

/**
 * Student reached pricing and the database without anyone grepping for
 * hand-rolled tier sets, and the web admin dropped paying students in four
 * places (engram-web#264). The constants fix the known sites; this stops a
 * new one. Forbidden in worker or shared source: a SQL `tier IN ('…')`
 * literal, a `=== "pro" || === "team"` chain, or an array literal of two
 * paid tiers. Single tier-specific checks (`tier === "team"` for seat math)
 * and `=== "free"` stay allowed — they are right for any tier added later.
 */

const REPO = join(__dirname, "../../../..");
const ROOTS = [join(__dirname, ".."), join(REPO, "packages/shared/src")];
const CONSTANTS = join(REPO, "packages/shared/src/constants.ts");

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (!/node_modules|__tests__|dist/.test(name)) yield* sources(p); continue; }
    if (!/\.ts$/.test(name) || /\.test\.|\.d\.ts$/.test(name) || p === CONSTANTS) continue;
    yield p;
  }
}

const PAID = "(pro|student|team|enterprise)";
const SQL_LITERAL = /tier IN \(\s*'/;
const CHAIN = new RegExp(`===\\s*["']${PAID}["'][^;\\n]*\\|\\|[^;\\n]*===\\s*["']${PAID}["']`);
const ARRAY = new RegExp(`\\[\\s*["']${PAID}["']\\s*,\\s*["']${PAID}["']`);

describe("PAID_TIERS", () => {
  it("covers every non-free tier", () => {
    const every: Exclude<Tier, "free">[] = ["pro", "student", "team", "enterprise"];
    for (const t of every) expect(isPaidTier(t), t).toBe(true);
    expect(isPaidTier("free")).toBe(false);
    expect([...PAID_TIERS].sort()).toEqual([...every].sort());
  });

  it("keeps the three sets distinct on purpose", () => {
    expect([...PRIORITY_SUPPORT_TIERS]).toEqual(["team", "enterprise"]);
    expect([...PURCHASABLE_PLANS]).toEqual(["pro", "team"]);
    expect(PURCHASABLE_PLANS as readonly string[]).not.toContain("student");
  });

  it("renders a safe SQL IN-list from a constant", () => {
    expect(sqlTierList(PAID_TIERS)).toBe("'pro','student','team','enterprise'");
  });

  it("no source file hand-rolls a tier set", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) for (const file of sources(root)) {
      readFileSync(file, "utf-8").split("\n").forEach((line, i) => {
        if (SQL_LITERAL.test(line) || CHAIN.test(line) || ARRAY.test(line)) {
          offenders.push(`${relative(REPO, file)}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(offenders, "derive from PAID_TIERS / PRIORITY_SUPPORT_TIERS / PURCHASABLE_PLANS:\n" + offenders.join("\n")).toEqual([]);
  });
});
