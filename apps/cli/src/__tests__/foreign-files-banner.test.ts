import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ForeignFiles } from "../daemon/ownership.js";
import type { RootDaemon } from "../daemon/root-daemon.js";

/**
 * engram#659 — the lines before a command that say files in ~/.engram are
 * another user's. This runs the CLI's entry as `engram <command>` does,
 * with the daemon commands and `engram status` faked: nothing here starts,
 * stops or looks for a daemon, and the home directory is a temp dir.
 */

const { home, found, ran, rootDaemon } = vi.hoisted(() => ({
  home: { dir: "" },
  found: { value: null as ForeignFiles | null | "throws" },
  ran: [] as string[],
  // engram#680: the daemon running as root that made them, if one runs.
  rootDaemon: { value: null as RootDaemon | null, looks: 0 },
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
vi.mock("../daemon/root-daemon.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/root-daemon.js")>()),
  findRootDaemon: () => {
    rootDaemon.looks++;
    return rootDaemon.value;
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

const DB_IS_ROOTS: ForeignFiles = {
  dir: false,
  files: ["daemon.db"],
  root: true,
  stopsDaemon: true,
  holdsSends: false,
};
const BANNER = [
  "engram: daemon.db in ~/.engram belongs to root, not to you, so the daemon can't start.",
  '  Make it yours with: sudo chown -R "$(id -un)" ~/.engram',
  "",
];
// engram#695: the daemon runs, and holds its sends.
const KEY_IS_ROOTS: ForeignFiles = {
  dir: false,
  files: ["vault-key"],
  root: true,
  stopsDaemon: false,
  holdsSends: true,
};
const KEY_BANNER = [
  "engram: vault-key in ~/.engram belongs to root, not to you. Until it is yours, captured messages wait on this machine: nothing is lost.",
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
    rootDaemon.value = null;
    rootDaemon.looks = 0;
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
    // What this command runs or prints, not what the one before it did.
    const before = ran.length + out.length;
    process.argv = [argv[0], "engram", ...words];
    vi.resetModules();
    await import("../index.js");
    await vi.waitFor(() => expect(ran.length + out.length).toBeGreaterThan(before));
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
    // It looked for a daemon running as root, and none runs.
    expect(rootDaemon.looks).toBe(1);
  });

  describe("with the daemon that made them still running as root (engram#680)", () => {
    const ROOT_BANNER = [
      "engram: A daemon started with sudo is still running as root (pid 4242).",
      "  Stop it with: sudo kill 4242",
      "engram: daemon.db in ~/.engram belongs to root, not to you, so the daemon can't start.",
      '  Then make it yours with: sudo chown -R "$(id -un)" ~/.engram',
      "",
    ];

    it("says to stop it first, then to make the files the user's", async () => {
      found.value = DB_IS_ROOTS;
      rootDaemon.value = { pid: 4242, job: null };
      await engram("version");
      expect(errs).toEqual(ROOT_BANNER);
      expect(out).toEqual([expect.stringMatching(/^engram \S+$/)]);
    });

    it("says to unload the job in launchd's system domain that runs it", async () => {
      found.value = DB_IS_ROOTS;
      rootDaemon.value = { pid: 4242, job: { pid: 4242 } };
      await engram("version");
      expect(errs).toEqual([
        ROOT_BANNER[0],
        "  Stop it with: sudo launchctl bootout system/app.getengram.daemon",
        ...ROOT_BANNER.slice(2),
      ]);
    });

    it("says to unload a job that would run another, besides stopping it", async () => {
      found.value = DB_IS_ROOTS;
      rootDaemon.value = { pid: 4242, job: { pid: null } };
      await engram("version");
      expect(errs).toEqual([
        ...ROOT_BANNER.slice(0, 2),
        "  Also unload the job 'sudo engram install' loaded into launchd's system domain: sudo launchctl bootout system/app.getengram.daemon",
        ...ROOT_BANNER.slice(2),
      ]);
    });

    it("isn't looked for when the files are another user's, not root's", async () => {
      found.value = { ...DB_IS_ROOTS, root: false };
      rootDaemon.value = { pid: 4242, job: null };
      await engram("version");
      expect(rootDaemon.looks).toBe(0);
      expect(errs).toEqual([
        "engram: daemon.db in ~/.engram belongs to another user, not to you, so the daemon can't start.",
        BANNER[1],
        "",
      ]);
    });

    it("isn't shown before stop, which says both itself", async () => {
      found.value = DB_IS_ROOTS;
      rootDaemon.value = { pid: 4242, job: null };
      for (const words of [["stop"], ["daemon", "stop"]]) {
        ran.length = 0;
        await engram(...words);
        expect(ran).toEqual(["stop"]);
      }
      expect(errs).toEqual([]);
    });
  });

  it("says another user's vault key holds sends, and that nothing is lost (engram#695)", async () => {
    found.value = KEY_IS_ROOTS;
    await engram("version");
    expect(errs).toEqual(KEY_BANNER);
  });

  // POSIX, and not as root: a file mode 000 can't be read then.
  it.skipIf(process.platform === "win32" || process.geteuid?.() === 0)(
    "says it once, not again as a vault key the daemon can't read (engram#695)",
    async () => {
      const dir = join(home.dir, ".engram");
      const key = join(dir, "vault-key");
      mkdirSync(dir, { recursive: true });
      // What the daemon records while it holds sends for the key.
      writeFileSync(
        join(dir, "status.json"),
        JSON.stringify({ health: "error", error_type: "vault_key", pending_messages: 3 }),
      );
      writeFileSync(key, "not read\n");
      chmodSync(key, 0o000);
      try {
        found.value = KEY_IS_ROOTS;
        await engram("version");
        expect(errs).toEqual(KEY_BANNER);

        // A key that isn't another user's, or whose can't be told: the
        // daemon's own words.
        const daemonSays = [
          "engram: Your vault key (~/.engram/vault-key) can't be read, so messages wait here rather than be sent with your vault's secrets in them. Nothing is lost. 3 messages waiting locally.",
          "  (run 'engram status' for details)",
          "",
        ];
        for (const value of [null, "throws"] as const) {
          errs.length = 0;
          found.value = value;
          await engram("version");
          expect(errs).toEqual(daemonSays);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("is nothing when everything is the user's, or they can't be looked at", async () => {
    await engram("version");
    found.value = "throws";
    await engram("version");
    expect(errs).toEqual([]);
    expect(out).toHaveLength(2);
  });
});
