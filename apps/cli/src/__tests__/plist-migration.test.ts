import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { workerPath } from "../daemon/launch.js";
import { PLIST_VERSION, generatePlist, pathsIn, type PlistPaths } from "../daemon/launchd.js";

/**
 * engram#469 — a plist is written once and never revisited, so a defect that
 * lives in it survives every CLI upgrade. These pin the two properties that
 * made the Sept 2026 silent-capture outage possible:
 *
 *   1. launchd must run worker.js (the ABI preflight bootstrap), never
 *      worker-main.js directly — the latter skips the self-heal entirely.
 *   2. the job must carry a PATH that can reach npm, or the self-heal's
 *      `npm rebuild better-sqlite3` dies with command-not-found.
 *
 * What `engram install` writes for this CLI, and how `engram start` and
 * auto-capture rewrite an older or broken plist, is in darwin-daemon.test.ts
 * (engram#616).
 */

const paths: PlistPaths = {
  node: "/opt/homebrew/Cellar/node/24.1.0/bin/node",
  worker: "/opt/homebrew/lib/node_modules/@getengram/cli/dist/daemon/worker.js",
  log: "/Users/op/.engram/daemon.log",
  home: "/Users/op",
  path: "/opt/homebrew/Cellar/node/24.1.0/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
};

describe("launchd plist generation", () => {
  it("launches the preflight bootstrap, not the raw worker", () => {
    // The real one, beside launch.ts: worker.ts here, dist/daemon/worker.js in a build.
    expect(workerPath()).toMatch(/[\\/]daemon[\\/]worker\.js$/);
    expect(generatePlist(paths)).toContain(
      `<key>ProgramArguments</key>\n  <array>\n    <string>${paths.node}</string>\n    <string>${paths.worker}</string>\n  </array>`,
    );
    for (const file of ["commands.ts", "launch.ts", "launchd.ts"]) {
      const src = readFileSync(join(__dirname, "..", "daemon", file), "utf-8");
      expect(src).not.toMatch(/["'](?:\.\/)?worker-main\.js["']/);
    }
  });

  it("gives the job a PATH, Node's own directory first", () => {
    expect(generatePlist(paths)).toContain(`<key>PATH</key>\n    <string>${paths.path}</string>`);
  });

  it("stamps a version so stale plists are detectable", () => {
    expect(PLIST_VERSION).toBeGreaterThanOrEqual(2);
    expect(generatePlist(paths)).toContain(
      `<key>ENGRAM_PLIST_VERSION</key>\n    <string>${PLIST_VERSION}</string>`,
    );
    expect(pathsIn(generatePlist(paths))).toEqual(paths);
  });
});
