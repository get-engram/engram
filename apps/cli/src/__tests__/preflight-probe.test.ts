import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The daemon's ABI self-heal (0.4.2) could never fire, and the reason is
 * subtle enough to be worth pinning in a test rather than a comment.
 *
 * `require("better-sqlite3")` resolves the JS wrapper and returns happily on
 * a machine whose native addon cannot load — the binding is bound lazily, on
 * first construction. The original preflight checked exactly that, so it
 * reported success, skipped the rebuild, and let worker-main die a few lines
 * later on the very ABI mismatch it existed to repair. The owner's machine
 * crashlooped that way 2,358 times across three weeks before anyone looked
 * at the log (engram#496).
 *
 * So the invariant is not "preflight requires sqlite" but "preflight OPENS a
 * database". A future refactor that trims the open back to a require would
 * silently restore three weeks of downtime, and nothing else would fail.
 */
const SRC = readFileSync(
  resolve(__dirname, "../daemon/preflight.ts"),
  "utf-8",
);

describe("daemon ABI preflight", () => {
  it("opens a database rather than only requiring the module", () => {
    expect(SRC).toMatch(/new Database\(":memory:"\)/);
    expect(SRC).toMatch(/\.close\(\)/);
  });

  it("never treats a bare require as proof the addon loads", () => {
    // Every require of better-sqlite3 must be feeding a construction, not
    // standing in as the check itself.
    const bareRequireAsCheck = /try\s*\{\s*req\(["']better-sqlite3["']\);\s*return true;/;
    expect(SRC).not.toMatch(bareRequireAsCheck);
  });

  it("re-probes after the rebuild instead of trusting the cached module", () => {
    // The failed module stays in require's cache, so a second require()
    // returns the broken one and reports a repair that did not happen.
    expect(SRC).toMatch(/delete req\.cache/);
  });
});
