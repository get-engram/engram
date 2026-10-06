import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * engram#469 — a plist is written once and never revisited, so a defect that
 * lives in it survives every CLI upgrade. These pin the two properties that
 * made the Sept 2026 silent-capture outage possible:
 *
 *   1. launchd must run worker.js (the ABI preflight bootstrap), never
 *      worker-main.js directly — the latter skips the self-heal entirely.
 *   2. the job must carry a PATH that can reach npm, or the self-heal's
 *      `npm rebuild better-sqlite3` dies with command-not-found.
 */
const src = readFileSync(
  join(__dirname, "..", "daemon", "commands.ts"),
  "utf-8",
);

describe("launchd plist generation", () => {
  it("launches the preflight bootstrap, not the raw worker", () => {
    expect(src).toMatch(/resolve\(dir,\s*"worker\.js"\)/);
    expect(src).not.toMatch(/resolve\(dir,\s*"worker-main\.js"\)/);
  });

  it("gives the job a PATH that includes node's own bin dir", () => {
    expect(src).toMatch(/const nodeBinDir = dirname\(nodePath\)/);
    expect(src).toMatch(/<key>PATH<\/key>/);
    expect(src).toMatch(/\$\{jobPath\}/);
  });

  it("stamps a version so stale plists are detectable", () => {
    expect(src).toMatch(/const PLIST_VERSION = \d+/);
    expect(src).toMatch(/<key>ENGRAM_PLIST_VERSION<\/key>/);
  });

  it("exports a migration that reruns on start, not only at install", () => {
    expect(src).toMatch(/export function migrateLaunchdIfStale/);
    // called from the start path and the auto-enable path
    const calls = src.match(/migrateLaunchdIfStale\(\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it("treats an unstamped plist as v1 so pre-fix installs migrate", () => {
    expect(src).toMatch(/return m \? parseInt\(m\[1\], 10\) : 1/);
  });
});
