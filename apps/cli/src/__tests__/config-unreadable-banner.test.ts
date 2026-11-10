import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * engram#673 — the lines before a command that say ~/.engram/config.json
 * can't be read, so capture waits. This runs the CLI's entry as `engram
 * <command>` does, with the commands faked: nothing here reads a key,
 * starts, stops or looks for a daemon, and the home directory is a temp
 * dir. config.json and status.json are real files in it.
 */

const { home, ran } = vi.hoisted(() => ({
  home: { dir: "" },
  ran: [] as string[],
}));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));
// Everything in ~/.engram is the user's (engram#659 has the rest).
vi.mock("../daemon/ownership.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/ownership.js")>()),
  foreignFiles: () => null,
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
vi.mock("../commands/login.js", () => ({
  signup: async () => void ran.push("signup"),
  login: async () => void ran.push("login"),
  link: async () => void ran.push("link"),
  whoami: async () => void ran.push("whoami"),
}));
vi.mock("../commands/auth.js", () => ({
  authLogin: async () => void ran.push("auth login"),
  authLogout: async () => void ran.push("auth logout"),
  authStatus: async () => void ran.push("auth status"),
}));
vi.mock("../commands/exclude.js", () => ({
  excludeAdd: async () => void ran.push("exclude add"),
  excludeRemove: async () => void ran.push("exclude remove"),
  excludeList: async () => void ran.push("exclude list"),
}));

home.dir = mkdtempSync(join(tmpdir(), "engram-673-banner-"));
afterAll(() => rmSync(home.dir, { recursive: true, force: true }));

const ENGRAM_DIR = join(home.dir, ".engram");
const CONFIG_FILE = join(ENGRAM_DIR, "config.json");
const STATUS_FILE = join(ENGRAM_DIR, "status.json");
const TAIL = "Q9Z7LEAK";
/** The file cut short just after the key: JSON.parse's own message quotes the end of the key. */
const BROKEN = `{"apiKey":"engram_sk_live_test_673_${TAIL}","n":x}`;
const GOOD = JSON.stringify({ apiKey: "engram_sk_live_test_673_fine", excludePaths: ["/work"] });
const SINCE = "2026-11-09T00:00:00.000Z";

/** What is said before a command while config.json is `problem`. */
const banner = (problem: string) => [
  `engram: ~/.engram/config.json ${problem}, so Engram can't tell which folders you excluded ` +
    "from capture. New messages wait until it's fixed; nothing is skipped.",
  "  (run 'engram status' for details)",
  "",
];

describe("the banner before a command (engram#673)", () => {
  const argv = process.argv;
  let out: string[];
  let errs: string[];

  beforeEach(() => {
    out = [];
    errs = [];
    ran.length = 0;
    rmSync(ENGRAM_DIR, { recursive: true, force: true });
    mkdirSync(ENGRAM_DIR, { mode: 0o700 });
    vi.stubEnv("NO_COLOR", "1");
    vi.stubEnv("ENGRAM_API_KEY", undefined);
    vi.stubEnv("ENGRAM_BASE_URL", undefined);
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
    // What this command runs or prints, not what the one before it did.
    const before = ran.length + out.length;
    process.argv = [argv[0], "engram", ...words];
    vi.resetModules();
    await import("../index.js");
    await vi.waitFor(() => expect(ran.length + out.length).toBeGreaterThan(before));
  }

  /** What the daemon recorded in status.json. */
  function daemonRecorded(captureError: Record<string, unknown>): void {
    writeFileSync(STATUS_FILE, JSON.stringify({ capture_error: { since: SINCE, files: 2, ...captureError } }));
  }

  it("says why capture waits before any other command, without quoting the file", async () => {
    writeFileSync(CONFIG_FILE, BROKEN);
    await engram("version");
    expect(errs).toEqual(banner("isn't valid JSON"));
    expect(out).toEqual([expect.stringMatching(/^engram \S+$/)]);
    expect(errs.join("\n")).not.toContain(TAIL.slice(-4));
  });

  it.each([
    { file: "empty", text: "", problem: "is empty" },
    { file: "a list", text: "[]", problem: "isn't a JSON object" },
    { file: "an excludePaths that's one path", text: '{"excludePaths":"/work"}', problem: "has an excludePaths that isn't a list of paths" },
  ])("says it for a file that's $file", async ({ text, problem }) => {
    writeFileSync(CONFIG_FILE, text);
    await engram("version");
    expect(errs).toEqual(banner(problem));
  });

  it("says it for a folder in the file's place", async () => {
    mkdirSync(CONFIG_FILE);
    await engram("version");
    expect(errs).toEqual(banner("is a folder, not a file"));
  });

  it("is shown before start and link, which don't say it themselves", async () => {
    writeFileSync(CONFIG_FILE, BROKEN);
    await engram("start");
    await engram("link");
    expect(ran).toEqual(["start", "link"]);
    expect(errs).toEqual([...banner("isn't valid JSON"), ...banner("isn't valid JSON")]);
  });

  it.each([
    "status", "daemon status",
    "signup", "login", "auth login", "auth logout",
    "stop", "daemon stop", "uninstall", "daemon uninstall",
    "exclude", "exclude add /work", "exclude remove /work", "exclude rm /work", "exclude list", "exclude ls",
  ])("isn't shown before `engram %s`, which says it itself", async (command) => {
    writeFileSync(CONFIG_FILE, BROKEN);
    await engram(...command.split(" "));
    expect(ran).toHaveLength(1);
    expect(errs).toEqual([]);
  });

  it("is said once, not again from the daemon's record of waiting", async () => {
    writeFileSync(CONFIG_FILE, BROKEN);
    daemonRecorded({ kind: "config", message: "~/.engram/config.json isn't valid JSON" });
    await engram("version");
    expect(errs).toEqual(banner("isn't valid JSON"));
  });

  it("is nothing once the file reads fine, before the daemon picks up", async () => {
    writeFileSync(CONFIG_FILE, GOOD);
    daemonRecorded({ kind: "config", message: "~/.engram/config.json isn't valid JSON" });
    await engram("version");
    expect(errs).toEqual([]);
  });

  it("leaves a stall queueing into daemon.db to its own banner", async () => {
    writeFileSync(CONFIG_FILE, GOOD);
    daemonRecorded({ message: "database or disk is full" });
    await engram("version");
    expect(errs[0]).toMatch(/^engram: Engram can't queue new messages on this machine \(database or disk is full\)/);
    expect(errs.join("\n")).not.toContain("config.json");
  });

  it("is nothing when the file is fine, or isn't there", async () => {
    await engram("version");
    writeFileSync(CONFIG_FILE, GOOD);
    await engram("version");
    expect(errs).toEqual([]);
    expect(out).toHaveLength(2);
  });
});
