import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The CLI routes commands through one switch on the command's words. A label
// listed twice compiles fine, and the first match wins. That is how `engram
// status` ran `engram usage` while the help, the docs, and the daemon's own
// messages described the daemon status (engram#609).
const SRC = readFileSync(resolve(__dirname, "../index.ts"), "utf-8");

const switchAt = SRC.indexOf("switch (cmd) {");
const ROUTES = SRC.slice(switchAt, SRC.indexOf("default:", switchAt));
const LABELS = [...ROUTES.matchAll(/case\s+"([^"]+)"\s*:/g)].map((m) => m[1]);

const exemptList = SRC.match(/const CAPTURE_EXEMPT = new Set\(\[([\s\S]*?)\]\);/)?.[1] ?? "";
const CAPTURE_EXEMPT = new Set([...exemptList.matchAll(/"([^"]+)"/g)].map((m) => m[1]));

describe("CLI command routing", () => {
  it("finds the switch it checks", () => {
    expect(switchAt).toBeGreaterThan(0);
    expect(LABELS).toContain("usage");
    expect(LABELS).toContain("daemon status");
    expect(LABELS.length).toBeGreaterThan(20);
  });

  it("routes each command to one place", () => {
    const repeated = LABELS.filter((label, i) => LABELS.indexOf(label) !== i);
    expect(repeated).toEqual([]);
  });

  it("sends `engram status` to the daemon-and-usage view, not to usage alone", () => {
    expect(ROUTES).toMatch(/case "status":\s*await showStatus\(args, flags\);/);
    expect(ROUTES).toMatch(/case "usage":\s*await showUsage\(args, flags\);/);
  });

  it("treats `engram daemon <x>` like `engram <x>` when deciding whether to start capture", () => {
    expect(CAPTURE_EXEMPT.size).toBeGreaterThan(10);
    for (const sub of ["start", "stop", "status", "install", "uninstall"]) {
      expect(CAPTURE_EXEMPT.has(sub), sub).toBe(true);
      expect(CAPTURE_EXEMPT.has(`daemon ${sub}`), `daemon ${sub}`).toBe(true);
    }
  });
});
