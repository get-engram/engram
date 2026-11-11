import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { scoopVersionOf, throughScoopCurrent } from "../daemon/scoop.js";

/**
 * engram#664 — on Windows, the sign-in entry names Scoop's Node by a path
 * that outlasts `scoop update` and `scoop cleanup`: node.exe in the current
 * version of a Scoop app, <root>\apps\<app>\<version>\node.exe, goes by
 * <root>\apps\<app>\current\node.exe.
 *
 * A Scoop root in a temp dir, as `scoop install nodejs nodejs-lts` leaves
 * one: each version of an app in its own folder, and `current` a junction to
 * the one in use. nodejs 22.11.0 is current and 22.10.0 still installed
 * (cleanup removes it); nodejs-lts is an app of its own; "nojunction" has no
 * `current`, as with Scoop's no_junction setting. On the Windows runner the
 * links are junctions, as Scoop makes them; elsewhere a directory symlink
 * stands in for one.
 */

// Real paths, as Node's own are: the runner's temp dir is an 8.3 short name,
// and macOS's is through a link.
const ROOT = realpathSync.native(mkdtempSync(join(tmpdir(), "engram-664-")));
const SCOOP = join(ROOT, "scoop");

/** node.exe, or another file, in a version of a Scoop app: <root>\apps\<app>\<version>\…. */
function version(app: string, v: string, ...rest: string[]): string {
  return join(SCOOP, "apps", app, v, ...(rest.length > 0 ? rest : ["node.exe"]));
}

/** The same file through the app's current junction: <root>\apps\<app>\current\…. */
function current(app: string, ...rest: string[]): string {
  return version(app, "current", ...rest);
}

/** A junction, as Scoop makes: Windows needs no privilege for one. */
function link(target: string, path: string): void {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

/** Point the app's current at this version, as `scoop update` and `scoop reset` do. */
function pointCurrent(app: string, v: string): void {
  rmSync(join(SCOOP, "apps", app, "current"), { force: true });
  link(join(SCOOP, "apps", app, v), join(SCOOP, "apps", app, "current"));
}

function file(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
}

beforeAll(() => {
  for (const path of [
    version("nodejs", "22.11.0"),
    version("nodejs", "22.10.0"),
    version("nodejs-lts", "20.18.0"),
    version("nojunction", "1.0.0"),
  ]) {
    file(path);
  }
  pointCurrent("nodejs", "22.11.0");
  pointCurrent("nodejs-lts", "20.18.0");
});

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("node.exe in a version of a Scoop app (engram#664)", () => {
  it("goes by the app's current junction, which leads to the same file", () => {
    for (const [app, v] of [
      ["nodejs", "22.11.0"],
      ["nodejs-lts", "20.18.0"],
    ]) {
      expect(throughScoopCurrent(version(app, v))).toBe(current(app));
      expect(realpathSync.native(current(app))).toBe(version(app, v));
    }
  });

  it("keeps its own path in a version that isn't the app's current one", () => {
    const older = version("nodejs", "22.10.0");
    expect(throughScoopCurrent(older)).toBe(older);
  });

  it("goes by the junction to whichever version is current: an update moves it", () => {
    const [older, newer] = [version("nodejs", "22.10.0"), version("nodejs", "22.11.0")];
    pointCurrent("nodejs", "22.10.0");
    try {
      expect(throughScoopCurrent(older)).toBe(current("nodejs"));
      expect(throughScoopCurrent(newer)).toBe(newer);
    } finally {
      pointCurrent("nodejs", "22.11.0");
    }
    expect(throughScoopCurrent(newer)).toBe(current("nodejs"));
  });

  it("keeps its own path with no current to go by, or nothing there", () => {
    for (const path of [version("nojunction", "1.0.0"), version("nodejs", "22.11.0", "gone.exe"), version("gone", "1.0.0")]) {
      expect(throughScoopCurrent(path)).toBe(path);
    }
  });

  it("keeps a file deeper in a version, which the next version may not have", () => {
    // A version manager installed with Scoop that keeps Node's versions in
    // its own folder: they aren't carried to its next version.
    const deeper = version("fnm", "1.38.0", "node-versions", "v22.11.0", "installation", "node.exe");
    file(deeper);
    pointCurrent("fnm", "1.38.0");
    expect(realpathSync.native(current("fnm", "node-versions", "v22.11.0", "installation", "node.exe"))).toBe(deeper);
    expect(throughScoopCurrent(deeper)).toBe(deeper);
  });

  it("keeps its own path when current isn't a junction to its version", () => {
    // A folder of its own, with a node.exe in it.
    const copied = version("copied", "1.0.0");
    for (const path of [copied, current("copied")]) file(path);
    // A junction to another app's version.
    const other = version("other", "1.0.0");
    file(other);
    link(join(SCOOP, "apps", "nodejs", "22.11.0"), join(SCOOP, "apps", "other", "current"));
    for (const path of [copied, other]) {
      expect(throughScoopCurrent(path)).toBe(path);
    }
  });

  it("keeps a path that isn't the real one: only the very file current leads to goes by it", () => {
    // Through a link to the Scoop root.
    link(SCOOP, join(ROOT, "alias"));
    const aliased = join(ROOT, "alias", "apps", "nodejs", "22.11.0", "node.exe");
    // With a `..` in it (join would take it out).
    const dotted = [SCOOP, "..", "scoop", "apps", "nodejs", "22.11.0", "node.exe"].join(sep);
    for (const path of [aliased, dotted]) {
      expect(throughScoopCurrent(path)).toBe(path);
    }
  });

  it("keeps an nvm-windows version: `nvm use` moves its link to whichever Node the user works with", () => {
    const nvm = join(ROOT, "nvm", "v22.11.0", "node.exe");
    file(nvm);
    link(dirname(nvm), join(ROOT, "nodejs"));
    expect(throughScoopCurrent(nvm)).toBe(nvm);
  });
});

describe("any other path (engram#664)", () => {
  it("is left as it is, and never looked up", () => {
    // Every engram start and status: anything not at the top of a Scoop
    // app's version costs nothing.
    const lookUp = vi.spyOn(realpathSync, "native").mockImplementation(() => {
      throw new Error("looked up");
    });
    try {
      for (const path of [
        // Other version managers', the installer's.
        "C:\\Users\\op\\AppData\\Roaming\\fnm\\node-versions\\v22.11.0\\installation\\node.exe",
        "C:\\Users\\op\\AppData\\Roaming\\nvm\\v22.11.0\\node.exe",
        "C:\\Program Files\\nodejs\\node.exe",
        // Already through current.
        "C:\\Users\\op\\scoop\\apps\\nodejs\\current\\node.exe",
        "C:\\Users\\op\\scoop\\apps\\nodejs\\Current\\node.exe",
        // The CLI, in the persist folder every version shares.
        "C:\\Users\\op\\scoop\\persist\\nodejs\\bin\\node_modules\\@getengram\\cli\\dist\\daemon\\login-start.js",
        // A version itself, an app's folder, a file deeper in a version.
        "C:\\Users\\op\\scoop\\apps\\nodejs\\22.11.0",
        "C:\\Users\\op\\scoop\\apps\\nodejs",
        "C:\\Users\\op\\scoop\\apps\\nodejs\\22.11.0\\bin\\node.exe",
        "/usr/local/bin/node",
        "",
      ]) {
        expect(throughScoopCurrent(path)).toBe(path);
      }
      expect(lookUp).not.toHaveBeenCalled();

      // Which it would see: node.exe at the top of a version is looked up, once.
      const inVersion = "C:\\Users\\op\\scoop\\apps\\nodejs\\22.11.0\\node.exe";
      expect(throughScoopCurrent(inVersion)).toBe(inVersion);
      expect(lookUp).toHaveBeenCalledTimes(1);
      expect(lookUp).toHaveBeenCalledWith("C:\\Users\\op\\scoop\\apps\\nodejs\\current\\node.exe");
    } finally {
      lookUp.mockRestore();
    }
  });
});

describe("an entry naming a version of the Scoop app this CLI's Node goes by `current` of (engram#664)", () => {
  const OURS = "C:\\Users\\op\\scoop\\apps\\nodejs\\current\\node.exe";
  const at = (v: string, app = "nodejs", rest = "node.exe") => `C:\\Users\\op\\scoop\\apps\\${app}\\${v}\\${rest}`;

  it("is one: the version current leads to, one it led to before the last update, one cleanup removed", () => {
    for (const entry of [at("22.11.0"), at("22.10.0"), at("20.0.0")]) {
      expect(scoopVersionOf(entry, OURS)).toBe(true);
    }
  });

  it("never names ours, or the app's current by another spelling: an entry this CLI wrote is never rewritten", () => {
    for (const entry of [OURS, at("Current"), at("CURRENT")]) {
      expect(scoopVersionOf(entry, OURS)).toBe(false);
    }
  });

  it("is the same Windows path whatever its case or separators", () => {
    expect(scoopVersionOf("c:/users/OP/Scoop/APPS/NodeJS/22.11.0/NODE.EXE", OURS)).toBe(true);
    expect(scoopVersionOf(at("22.11.0"), "c:/users/OP/Scoop/APPS/NodeJS/Current/NODE.EXE")).toBe(true);
  });

  it("is never another app's, another root's, or another file's", () => {
    for (const entry of [
      at("20.18.0", "nodejs-lts"),
      at("22.11.0", "nodejs2"),
      "C:\\ProgramData\\scoop\\apps\\nodejs\\22.11.0\\node.exe",
      "D:\\scoop\\apps\\nodejs\\22.11.0\\node.exe",
      at("22.11.0", "nodejs", "node64.exe"),
      // Deeper in a version.
      at("22.11.0", "nodejs", "bin\\node.exe"),
    ]) {
      expect(scoopVersionOf(entry, OURS)).toBe(false);
    }
  });

  it("is never one when this CLI's Node isn't by a current: a working entry isn't traded for a version", () => {
    for (const ours of [
      // A version that isn't current, an app with no current.
      at("22.10.0"),
      at("1.0.0", "nojunction"),
      // Node that isn't Scoop's.
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\Users\\op\\AppData\\Roaming\\nvm\\v22.11.0\\node.exe",
      // Deeper in an app's current.
      "C:\\Users\\op\\scoop\\apps\\fnm\\current\\node-versions\\v22.11.0\\installation\\node.exe",
    ]) {
      for (const entry of [at("22.11.0"), at("22.10.0"), OURS]) {
        expect(scoopVersionOf(entry, ours)).toBe(false);
      }
    }
  });

  it("looks nothing up", () => {
    const lookUp = vi.spyOn(realpathSync, "native").mockImplementation(() => {
      throw new Error("looked up");
    });
    try {
      expect(scoopVersionOf(at("22.11.0"), OURS)).toBe(true);
      expect(scoopVersionOf(OURS, OURS)).toBe(false);
      expect(scoopVersionOf(at("22.11.0"), at("22.10.0"))).toBe(false);
      expect(lookUp).not.toHaveBeenCalled();
    } finally {
      lookUp.mockRestore();
    }
  });
});
