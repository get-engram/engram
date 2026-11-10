import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pinnedToKeg, throughOptLink } from "../daemon/homebrew.js";

/**
 * engram#652 — start at login names Node and the worker by a path that
 * outlasts `brew upgrade`: a file in the current version of a Homebrew keg,
 * <prefix>/Cellar/<formula>/<version>/…, goes by <prefix>/opt/<formula>/….
 *
 * A Homebrew prefix in a temp dir, as `brew install` leaves one: each version
 * in its keg under Cellar/, and opt/<formula> a relative link to the current
 * one. node 25.1.0 is current and 25.0.0 still installed; node@22 is a formula
 * of its own; "unlinked" has a keg and no opt link.
 */

/** Links: Windows makes them only with a privilege. */
const posixIt = process.platform === "win32" ? it.skip : it;

// Real paths, as Node's own are: macOS's temp dir is through a link.
const ROOT = realpathSync.native(mkdtempSync(join(tmpdir(), "engram-652-")));
const BREW = join(ROOT, "brew");
const WORKER = ["libexec", "lib", "node_modules", "@getengram", "cli", "dist", "daemon", "worker.js"];

/** A file in a keg: <prefix>/Cellar/<formula>/<version>/…. */
function keg(formula: string, version: string, ...rest: string[]): string {
  return join(BREW, "Cellar", formula, version, ...rest);
}

/** The same file through the formula's opt link: <prefix>/opt/<formula>/…. */
function opt(formula: string, ...rest: string[]): string {
  return join(BREW, "opt", formula, ...rest);
}

/** Point opt/<formula> at this version, as `brew upgrade` and `brew link` do. */
function linkOpt(formula: string, version: string): void {
  rmSync(opt(formula), { force: true });
  symlinkSync(`../Cellar/${formula}/${version}`, opt(formula));
}

beforeAll(() => {
  if (process.platform === "win32") return;
  for (const file of [
    keg("node", "25.1.0", "bin", "node"),
    keg("node", "25.0.0", "bin", "node"),
    keg("node@22", "22.10.0", "bin", "node"),
    keg("engram", "0.7.0", ...WORKER),
    keg("unlinked", "1.0.0", "bin", "tool"),
  ]) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "");
  }
  mkdirSync(join(BREW, "opt"));
  linkOpt("node", "25.1.0");
  linkOpt("node@22", "22.10.0");
  linkOpt("engram", "0.7.0");
});

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("a file in a Homebrew keg (engram#652)", () => {
  posixIt("goes by its formula's opt link, which leads to the same file", () => {
    for (const [inKeg, throughOpt] of [
      [keg("node", "25.1.0", "bin", "node"), opt("node", "bin", "node")],
      [keg("node@22", "22.10.0", "bin", "node"), opt("node@22", "bin", "node")],
      [keg("engram", "0.7.0", ...WORKER), opt("engram", ...WORKER)],
    ]) {
      expect(throughOptLink(inKeg)).toBe(throughOpt);
      expect(realpathSync.native(throughOpt)).toBe(inKeg);
      expect(pinnedToKeg(inKeg)).toBe(true);
    }
  });

  posixIt("goes by the opt link of a prefix that is itself in a directory named Cellar", () => {
    // Homebrew's Cellar is the last one in the path: its prefix can be
    // anywhere, and what follows a keg is Node's layout or the CLI's.
    const prefix = join(ROOT, "Cellar", "brew");
    const inKeg = join(prefix, "Cellar", "node", "25.1.0", "bin", "node");
    mkdirSync(dirname(inKeg), { recursive: true });
    writeFileSync(inKeg, "");
    mkdirSync(join(prefix, "opt"));
    symlinkSync("../Cellar/node/25.1.0", join(prefix, "opt", "node"));
    expect(throughOptLink(inKeg)).toBe(join(prefix, "opt", "node", "bin", "node"));
    expect(pinnedToKeg(inKeg)).toBe(true);
  });

  posixIt("keeps its own path in a version that isn't the formula's current one", () => {
    const older = keg("node", "25.0.0", "bin", "node");
    expect(throughOptLink(older)).toBe(older);
    expect(pinnedToKeg(older)).toBe(false);
  });

  posixIt("goes by the link to whichever version is current: an upgrade moves it", () => {
    const [older, newer] = [keg("node", "25.0.0", "bin", "node"), keg("node", "25.1.0", "bin", "node")];
    linkOpt("node", "25.0.0");
    try {
      expect(throughOptLink(older)).toBe(opt("node", "bin", "node"));
      expect(throughOptLink(newer)).toBe(newer);
    } finally {
      linkOpt("node", "25.1.0");
    }
    expect(throughOptLink(newer)).toBe(opt("node", "bin", "node"));
  });

  posixIt("keeps its own path with no opt link to go by, or nothing there", () => {
    for (const path of [
      keg("unlinked", "1.0.0", "bin", "tool"),
      keg("node", "25.1.0", "bin", "gone"),
      keg("gone", "1.0.0", "bin", "node"),
    ]) {
      expect(throughOptLink(path)).toBe(path);
      expect(pinnedToKeg(path)).toBe(false);
    }
  });

  posixIt("keeps its own path when opt/<formula> isn't a link to its keg", () => {
    // A directory of its own, with a file of the same name in it.
    const copied = keg("copied", "1.0.0", "bin", "node");
    for (const file of [copied, opt("copied", "bin", "node")]) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "");
    }
    // A link to another formula's keg.
    const other = keg("other", "1.0.0", "bin", "node");
    mkdirSync(dirname(other), { recursive: true });
    writeFileSync(other, "");
    symlinkSync("../Cellar/node/25.1.0", opt("other"));
    for (const path of [copied, other]) {
      expect(throughOptLink(path)).toBe(path);
      expect(pinnedToKeg(path)).toBe(false);
    }
  });

  posixIt("keeps a path that isn't the real one: only the very file the link leads to goes by it", () => {
    // Through a link to the prefix.
    symlinkSync(BREW, join(ROOT, "alias"));
    const aliased = join(ROOT, "alias", "Cellar", "node", "25.1.0", "bin", "node");
    // With a `..` in it (join would take it out).
    const dotted = `${keg("node", "25.1.0", "bin")}/../bin/node`;
    for (const path of [aliased, dotted]) {
      expect(throughOptLink(path)).toBe(path);
      expect(pinnedToKeg(path)).toBe(false);
    }
  });
});

describe("any other path (engram#652)", () => {
  it("is left as it is, and never looked up", () => {
    // Read on every engram command after auto-capture is on: anything not in
    // a keg costs nothing.
    const lookUp = vi.spyOn(realpathSync, "native").mockImplementation(() => {
      throw new Error("looked up");
    });
    try {
      for (const path of [
        // A version manager's, a system one, Windows's.
        "/Users/someone/.local/share/fnm/node-versions/v22.10.0/installation/bin/node",
        "/usr/local/bin/node",
        "C:\\Program Files\\nodejs\\node.exe",
        // Already through the link.
        join(BREW, "opt", "node", "bin", "node"),
        // A keg itself, or a formula's directory: no file in a keg.
        join(BREW, "Cellar", "node", "25.1.0"),
        join(BREW, "Cellar", "node"),
        "/Cellar/node/25.1.0/bin/node",
        "",
      ]) {
        expect(throughOptLink(path)).toBe(path);
        expect(pinnedToKeg(path)).toBe(false);
      }
      expect(lookUp).not.toHaveBeenCalled();

      // Which it would see: a file in a keg is looked up, once.
      const inKeg = "/opt/homebrew/Cellar/node/25.1.0/bin/node";
      expect(throughOptLink(inKeg)).toBe(inKeg);
      expect(lookUp).toHaveBeenCalledTimes(1);
      expect(lookUp).toHaveBeenCalledWith("/opt/homebrew/opt/node/bin/node");
    } finally {
      lookUp.mockRestore();
    }
  });
});
