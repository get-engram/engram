import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ForeignFiles } from "../daemon/ownership.js";

/**
 * engram#659 — the lines before a command that say files in ~/.engram are
 * another user's. This runs the CLI's entry as `engram <command>` does,
 * with the daemon commands and `engram status` faked: nothing here starts,
 * stops or looks for a daemon, and the home directory is a temp dir.
 */

const { home, found, ran } = vi.hoisted(() => ({
  home: { dir: "" },
  found: { value: null as ForeignFiles | null | "throws" },
  ran: [] as string[],
}));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));
vi.mock("../daemon/ownership.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/ownership.js")>()),
  foreignFiles: () => {
    if (found.value === "throws") throw new Error("EACCES: permission denied");
    return found.value;
  },
}));
vi.mock("../daemon/index.js", () => ({
  daemonStart: async () => void ran.push("start"),
  daemonStop: async () => void ran.push("stop"),
  daemonStatus: async () => void ran.push("daemon status"),
  daemonInstall: async () => void ran.push("install"),
  daemonUninstall: async () => void ran.push("uninstall"),
}));
vi.mock("../commands/status.js", () => ({
  status: async () => void ran.push("status"),
}));

home.dir = mkdtempSync(join(tmpdir(), "engram-659b-"));
afterAll(() => rmSync(home.dir, { recursive: true, force: true }));

const DB_IS_ROOTS: ForeignFiles = { dir: false, files: ["daemon.db"], root: true, stopsDaemon: true, stopsStart: false };
const BANNER = [
  "engram: daemon.db in ~/.engram belongs to root, not to you, so the daemon can't start.",
  '  Make it yours with: sudo chown -R "$(id -un)" ~/.engram',
  "",
];

describe("the banner before a command (engram#659)", () => {
  const argv = process.argv;
  let out: string[];
  let errs: string[];

  beforeEach(() => {
    out = [];
    errs = [];
    ran.length = 0;
    found.value = null;
    vi.stubEnv("NO_COLOR", "1");
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void out.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errs.push(args.join(" ")));
  });

  afterEach(() => {
    process.argv = argv;
    process.exitCode = undefined;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** `engram <words>`: the entry runs its command as it is imported. */
  async function engram(...words: string[]): Promise<void> {
    process.argv = [argv[0], "engram", ...words];
    vi.resetModules();
    await import("../index.js");
    await vi.waitFor(() => expect(ran.length + out.length).toBeGreaterThan(0));
  }

  it("says whose they are and the fix before any other command", async () => {
    found.value = DB_IS_ROOTS;
    await engram("version");
    expect(errs).toEqual(BANNER);
    expect(out).toEqual([expect.stringMatching(/^engram \S+$/)]);
  });

  it("isn't shown before start, install or status, which say it themselves", async () => {
    found.value = DB_IS_ROOTS;
    for (const words of [["start"], ["daemon", "start"], ["install"], ["daemon", "install"], ["status"], ["daemon", "status"]]) {
      ran.length = 0;
      await engram(...words);
      expect(ran).toHaveLength(1);
    }
    expect(errs).toEqual([]);
  });

  it("is shown before stop, which doesn't say it itself", async () => {
    found.value = DB_IS_ROOTS;
    await engram("stop");
    expect(ran).toEqual(["stop"]);
    expect(errs).toEqual(BANNER);
  });

  it("is nothing when everything is the user's, or they can't be looked at", async () => {
    await engram("version");
    found.value = "throws";
    await engram("version");
    expect(errs).toEqual([]);
    expect(out).toHaveLength(2);
  });
});
