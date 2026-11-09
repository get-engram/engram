import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  existsSync,
  fchownSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

// engram#627: ~/.engram holds the API key, the vault key and the daemon's
// queue of captured transcript text, and it got the defaults, 0755 and 0644
// under the usual umask: other accounts on the machine could read the
// daemon's copy of transcripts they can't read at the source. Now the
// folder is 0700 and every file in it 0600, on new installs and old ones,
// and config.json is replaced in one step, so a save cut short never leaves
// it truncated, without the key.

const { home, launchctl } = vi.hoisted(() => ({ home: { dir: "" }, launchctl: vi.fn() }));

// Each wraps the real call, so a test can make one of them fail.
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    renameSync: vi.fn(fs.renameSync),
    writeFileSync: vi.fn(fs.writeFileSync),
    fsyncSync: vi.fn(fs.fsyncSync),
    fchownSync: vi.fn(fs.fchownSync),
    chownSync: vi.fn(fs.chownSync),
  };
});

// config.ts, vault.ts and launch.ts keep their files in ~/.engram: a temp home.
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));

// Nothing is run. `engram install` on macOS runs launchctl, which would load
// a launchd job under a real install's label.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execSync: launchctl,
  execFile: vi.fn(),
  execFileSync: vi.fn(() => {
    throw new Error("not run in these tests");
  }),
  spawn: vi.fn(() => {
    throw new Error("not run in these tests");
  }),
}));

home.dir = mkdtempSync(join(tmpdir(), "engram-627-home-"));
const ENGRAM = join(home.dir, ".engram");

// After the temp home is set: these take their paths from it when imported.
const {
  createPrivateFileSync,
  ensurePrivateDirSync,
  makeDirPrivateSync,
  restrictSync,
  STALE_TEMP_MS,
  writePrivateFileSync,
} = await import("../private-files.js");
const { loadConfig, saveConfig } = await import("../config.js");
const { vaultKeygen } = await import("../commands/vault.js");
const { LOG_FILE, prepareLogSync } = await import("../daemon/launch.js");
const { DaemonDb } = await import("../daemon/db.js");
const { daemonInstall, migrateLaunchdIfStale } = await import("../daemon/commands.js");

process.on("exit", () => rmSync(home.dir, { recursive: true, force: true }));

const posix = process.platform !== "win32";
const root = process.geteuid?.() === 0;
/** Modes mean nothing on Windows, where files take the profile's ACL. */
const posixIt = it.skipIf(!posix);

const mode = (path: string) => statSync(path).mode & 0o777;
const errno = (code: string) => Object.assign(new Error(`${code}: injected`), { code });
const temps = (dir: string) => readdirSync(dir).filter((name) => name.endsWith(".tmp"));
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return (err as NodeJS.ErrnoException).code;
  }
  return undefined;
};

/** Another user, as far as the code under test can tell. */
function asAnotherUser(): void {
  const uid = process.geteuid!();
  vi.spyOn(process as Required<NodeJS.Process>, "geteuid").mockReturnValue(uid + 1);
}

/**
 * A package in `at`/store, linked from `at`/app/node_modules the way pnpm
 * installs one. Returns where its main file really is.
 */
function linkedPackage(at: string, name: string): string {
  const pkg = join(at, "store", name);
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name, main: "index.js" }));
  writeFileSync(join(pkg, "index.js"), "module.exports = {};\n");
  mkdirSync(join(at, "app", "node_modules"), { recursive: true });
  symlinkSync(pkg, join(at, "app", "node_modules", name), "dir");
  return realpathSync.native(join(pkg, "index.js"));
}

/** Root, as `sudo engram …` is when sudo keeps HOME. */
function asRoot(): void {
  vi.spyOn(process as Required<NodeJS.Process>, "geteuid").mockReturnValue(0);
}

const realPlatform = process.platform;
function onWindows(): void {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
}
function onMac(): void {
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
}

let dir: string;
let umask: number | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engram-627-"));
  rmSync(ENGRAM, { recursive: true, force: true });
  // The usual umask, whatever this machine's is: what the defaults gave.
  if (posix) umask = process.umask(0o022);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  if (umask !== undefined) process.umask(umask);
  vi.restoreAllMocks();
  for (const fn of [renameSync, writeFileSync, fsyncSync, fchownSync, chownSync]) vi.mocked(fn).mockReset();
  launchctl.mockReset();
  rmSync(dir, { recursive: true, force: true });
});

describe("ensurePrivateDirSync: ~/.engram (engram#627)", () => {
  posixIt("creates the folder 0700", () => {
    const engram = join(dir, ".engram");
    expect(ensurePrivateDirSync(engram)).toBe("created");
    expect(mode(engram)).toBe(0o700);
  });

  posixIt("tightens a folder from before the fix, once", () => {
    const engram = join(dir, ".engram");
    mkdirSync(engram);
    chmodSync(engram, 0o755);
    expect(ensurePrivateDirSync(engram)).toBe("changed");
    expect(mode(engram)).toBe(0o700);
    expect(ensurePrivateDirSync(engram)).toBe("private");
  });

  posixIt("leaves another user's folder as it is", () => {
    const engram = join(dir, ".engram");
    mkdirSync(engram);
    chmodSync(engram, 0o755);
    asAnotherUser();
    expect(ensurePrivateDirSync(engram)).toBe("not-ours");
    expect(mode(engram)).toBe(0o755);
  });

  it.skipIf(!posix || root)("as root, gives a folder it creates to the owner of the one it is in", () => {
    const parent = statSync(dir);
    asRoot();
    vi.mocked(chownSync).mockImplementation(() => {});
    const engram = join(dir, ".engram");
    expect(ensurePrivateDirSync(engram)).toBe("created");
    expect(chownSync).toHaveBeenCalledExactlyOnceWith(engram, parent.uid, parent.gid);
  });

  it("not as root, never changes an owner", () => {
    ensurePrivateDirSync(join(dir, ".engram"));
    expect(chownSync).not.toHaveBeenCalled();
  });

  it("on Windows, only creates it: the profile's ACL is private already", () => {
    onWindows();
    const engram = join(dir, ".engram");
    expect(ensurePrivateDirSync(engram)).toBe("created");
    if (posix) chmodSync(engram, 0o755);
    expect(ensurePrivateDirSync(engram)).toBe("private");
    if (posix) expect(mode(engram)).toBe(0o755);
  });
});

describe("writePrivateFileSync: 0600, replaced in one step (engram#627)", () => {
  it("creates a file 0600, and leaves no temp file", () => {
    const file = join(dir, "config.json");
    writePrivateFileSync(file, "new");
    expect(readFileSync(file, "utf-8")).toBe("new");
    if (posix) expect(mode(file)).toBe(0o600);
    expect(temps(dir)).toEqual([]);
  });

  it("replaces a file from before the fix: 0644 becomes 0600", () => {
    const file = join(dir, "config.json");
    writeFileSync(file, "old");
    if (posix) chmodSync(file, 0o644);
    writePrivateFileSync(file, "new");
    expect(readFileSync(file, "utf-8")).toBe("new");
    if (posix) expect(mode(file)).toBe(0o600);
    expect(temps(dir)).toEqual([]);
  });

  posixIt("writes through a symlink to the file it points at", () => {
    mkdirSync(join(dir, "elsewhere"));
    const target = join(dir, "elsewhere", "config.json");
    writeFileSync(target, "old");
    const link = join(dir, "config.json");
    symlinkSync(target, link);
    writePrivateFileSync(link, "new");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("new");
    expect(mode(target)).toBe(0o600);
    expect(temps(join(dir, "elsewhere"))).toEqual([]);
  });

  it.skipIf(!posix || root)("refuses a file it couldn't have written in place, and leaves it as it was", () => {
    const file = join(dir, "config.json");
    writeFileSync(file, "old");
    chmodSync(file, 0o400);
    expect(codeOf(() => writePrivateFileSync(file, "new"))).toBe("EACCES");
    expect(readFileSync(file, "utf-8")).toBe("old");
    expect(mode(file)).toBe(0o400);
    expect(temps(dir)).toEqual([]);
  });

  it("a write cut short (a full disk) leaves the old file whole, and no temp file", () => {
    const file = join(dir, "config.json");
    writeFileSync(file, "old");
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw errno("ENOSPC");
    });
    expect(codeOf(() => writePrivateFileSync(file, "new"))).toBe("ENOSPC");
    expect(readFileSync(file, "utf-8")).toBe("old");
    expect(temps(dir)).toEqual([]);
  });

  it("a rename that fails leaves the old file whole, and no temp file", () => {
    const file = join(dir, "config.json");
    writeFileSync(file, "old");
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw errno("EIO");
    });
    expect(codeOf(() => writePrivateFileSync(file, "new"))).toBe("EIO");
    expect(readFileSync(file, "utf-8")).toBe("old");
    expect(temps(dir)).toEqual([]);
  });

  it("flushes the new content to disk before the rename, unless asked not to", () => {
    const file = join(dir, "config.json");
    vi.mocked(fsyncSync).mockClear();
    writePrivateFileSync(file, "durable");
    const fsyncs = vi.mocked(fsyncSync).mock.invocationCallOrder;
    // The file, then (off Windows) the folder, so the rename survives a power cut.
    expect(fsyncs).toHaveLength(posix ? 2 : 1);
    expect(fsyncs[0]).toBeLessThan(vi.mocked(renameSync).mock.invocationCallOrder[0]);

    vi.mocked(fsyncSync).mockClear();
    writePrivateFileSync(file, "status", { durable: false });
    expect(fsyncSync).not.toHaveBeenCalled();
    expect(readFileSync(file, "utf-8")).toBe("status");
  });

  it("on Windows, retries a rename refused while another program has the file open", () => {
    onWindows();
    const file = join(dir, "config.json");
    writeFileSync(file, "old");
    vi.mocked(renameSync)
      .mockImplementationOnce(() => {
        throw errno("EPERM");
      })
      .mockImplementationOnce(() => {
        throw errno("EBUSY");
      });
    writePrivateFileSync(file, "new");
    expect(renameSync).toHaveBeenCalledTimes(3);
    expect(readFileSync(file, "utf-8")).toBe("new");
    expect(temps(dir)).toEqual([]);
  });

  it("on Windows, gives up after five retries, and leaves the old file whole", () => {
    onWindows();
    const file = join(dir, "config.json");
    writeFileSync(file, "old");
    vi.mocked(renameSync).mockImplementation(() => {
      throw errno("EACCES");
    });
    expect(codeOf(() => writePrivateFileSync(file, "new"))).toBe("EACCES");
    expect(renameSync).toHaveBeenCalledTimes(6);
    expect(readFileSync(file, "utf-8")).toBe("old");
    expect(temps(dir)).toEqual([]);
  });

  posixIt("off Windows, a refused rename isn't retried", () => {
    const file = join(dir, "config.json");
    writeFileSync(file, "old");
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw errno("EPERM");
    });
    expect(codeOf(() => writePrivateFileSync(file, "new"))).toBe("EPERM");
    expect(renameSync).toHaveBeenCalledTimes(1);
    expect(readFileSync(file, "utf-8")).toBe("old");
  });

  it.skipIf(!posix || root)("as root, gives what it writes to the owner of the folder (sudo keeping HOME)", () => {
    const folder = statSync(dir);
    asRoot();
    vi.mocked(fchownSync).mockImplementation(() => {});
    writePrivateFileSync(join(dir, "config.json"), "{}");
    expect(fchownSync).toHaveBeenCalledExactlyOnceWith(expect.any(Number), folder.uid, folder.gid);
  });

  it("not as root, never changes an owner", () => {
    writePrivateFileSync(join(dir, "config.json"), "{}");
    expect(fchownSync).not.toHaveBeenCalled();
  });
});

describe("restrictSync and createPrivateFileSync", () => {
  posixIt("restrictSync: the user's file to 0600; a missing or another user's file left alone", () => {
    const file = join(dir, "daemon.log");
    expect(restrictSync(file)).toBe("missing");
    writeFileSync(file, "x");
    chmodSync(file, 0o644);
    expect(restrictSync(file)).toBe("changed");
    expect(mode(file)).toBe(0o600);
    expect(restrictSync(file)).toBe("private");

    chmodSync(file, 0o644);
    asAnotherUser();
    expect(restrictSync(file)).toBe("not-ours");
    expect(mode(file)).toBe(0o644);
  });

  posixIt("createPrivateFileSync: a new empty file 0600; an existing one untouched", () => {
    const file = join(dir, "daemon.db");
    createPrivateFileSync(file);
    expect(mode(file)).toBe(0o600);
    expect(statSync(file).size).toBe(0);

    writeFileSync(file, "queue");
    createPrivateFileSync(file);
    expect(readFileSync(file, "utf-8")).toBe("queue");
  });
});

describe("makeDirPrivateSync: the daemon's start (engram#627)", () => {
  const FILES = [
    "config.json",
    "daemon.db",
    "daemon.db-wal",
    "daemon.db-shm",
    "daemon.log",
    "daemon.pid",
    "status.json",
    "vault-key",
    "vault-key.bak-2026-01-01T00-00-00-000Z",
    "a-file-of-something-else",
  ];

  function oldInstall(): string {
    const engram = join(dir, ".engram");
    mkdirSync(engram);
    chmodSync(engram, 0o755);
    for (const name of FILES) {
      writeFileSync(join(engram, name), "x");
      chmodSync(join(engram, name), 0o644);
    }
    return engram;
  }

  posixIt("makes an install from before the fix private: the folder 0700, every file in it 0600", () => {
    const engram = oldInstall();
    const report = makeDirPrivateSync(engram);
    expect(report.dir).toBe("changed");
    expect([...report.changed].sort()).toEqual([...FILES].sort());
    expect(report.skipped).toEqual([]);
    expect(report.removed).toEqual([]);
    expect(mode(engram)).toBe(0o700);
    for (const name of FILES) expect(mode(join(engram, name)), name).toBe(0o600);
    // The next start has nothing to do.
    expect(makeDirPrivateSync(engram)).toEqual({ dir: "private", changed: [], skipped: [], removed: [] });
  });

  posixIt("creates the folder 0700 on a fresh install", () => {
    const engram = join(dir, ".engram");
    expect(makeDirPrivateSync(engram)).toEqual({ dir: "created", changed: [], skipped: [], removed: [] });
    expect(mode(engram)).toBe(0o700);
  });

  posixIt("leaves symlinks, what they point at, and subfolders alone: nothing outside ~/.engram changes", () => {
    const engram = join(dir, ".engram");
    mkdirSync(engram, { mode: 0o700 });
    const outside = join(dir, "outside.txt");
    writeFileSync(outside, "x");
    chmodSync(outside, 0o644);
    symlinkSync(outside, join(engram, "link"));
    mkdirSync(join(engram, "sub"));
    chmodSync(join(engram, "sub"), 0o755);
    writeFileSync(join(engram, "sub", "inner"), "x");
    chmodSync(join(engram, "sub", "inner"), 0o644);

    const report = makeDirPrivateSync(engram);
    expect(report.changed).toEqual([]);
    expect(mode(outside)).toBe(0o644);
    expect(mode(join(engram, "sub"))).toBe(0o755);
    expect(mode(join(engram, "sub", "inner"))).toBe(0o644);
  });

  posixIt("leaves another user's folder and files as they are, and says so", () => {
    const engram = oldInstall();
    asAnotherUser();
    const report = makeDirPrivateSync(engram);
    expect(report.dir).toBe("not-ours");
    expect([...report.skipped].sort()).toEqual([...FILES].sort());
    expect(report.changed).toEqual([]);
    expect(mode(engram)).toBe(0o755);
    for (const name of FILES) expect(mode(join(engram, name)), name).toBe(0o644);
  });

  it("removes stale temp files of config.json, status.json and daemon.pid, and nothing else", () => {
    const engram = join(dir, ".engram");
    mkdirSync(engram);
    const stale = ["config.json.123.deadbeef.tmp", "status.json.45678.0badf00d.tmp", "daemon.pid.910.c0ffee00.tmp"];
    const writing = "config.json.123.cafef00d.tmp"; // a write in progress
    const kept = [
      "vault-key.123.deadbeef.tmp",
      "daemon.db.123.deadbeef.tmp",
      "config.json.tmp",
      "config.json.bak",
      "config.json.123.ABCDEF12.tmp", // a distinct name: macOS and Windows ignore case
      "config.json.x.deadbeef.tmp",
      "config.json",
    ];
    const old = (Date.now() - STALE_TEMP_MS - 60_000) / 1000;
    for (const name of [...stale, writing, ...kept]) writeFileSync(join(engram, name), "x");
    for (const name of [...stale, ...kept]) utimesSync(join(engram, name), old, old);

    const report = makeDirPrivateSync(engram);
    expect([...report.removed].sort()).toEqual([...stale].sort());
    expect(readdirSync(engram).sort()).toEqual([writing, ...kept].sort());
  });

  // engram#612: the daemon's socket is in ~/.engram. A plain stat of a
  // socket made Node resolve the next package it loaded to its symlink, not
  // to where it is, and that package then couldn't find its own
  // dependencies.
  posixIt("leaves how Node finds packages as it was when ~/.engram holds the daemon's socket", async () => {
    // A socket path can be 103 bytes at most on macOS: a long TMPDIR won't do.
    const base = mkdtempSync(join(Buffer.byteLength(tmpdir()) <= 60 ? tmpdir() : "/tmp", "e612p-"));
    const server = createServer();
    try {
      const engram = join(base, ".engram");
      mkdirSync(engram, { mode: 0o700 });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(join(engram, "daemon.sock"), () => resolve());
      });
      const req = createRequire(join(base, "app", "main.js"));
      // A running CLI has resolved its own packages: the folders on the way are known.
      linkedPackage(base, "first");
      req.resolve("first");
      const second = linkedPackage(base, "second");

      expect(makeDirPrivateSync(engram)).toEqual({ dir: "private", changed: [], skipped: [], removed: [] });
      expect(req.resolve("second")).toBe(second);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("the files in ~/.engram (engram#627)", () => {
  it("config.json on a fresh install: ~/.engram 0700, config.json 0600", async () => {
    await saveConfig({ apiKey: "engram_sk_test_627" });
    expect((await loadConfig()).apiKey).toBe("engram_sk_test_627");
    if (posix) {
      expect(mode(ENGRAM)).toBe(0o700);
      expect(mode(join(ENGRAM, "config.json"))).toBe(0o600);
    }
  });

  posixIt("config.json from before the fix: the folder and the file tightened", async () => {
    mkdirSync(ENGRAM);
    chmodSync(ENGRAM, 0o755);
    writeFileSync(join(ENGRAM, "config.json"), JSON.stringify({ apiKey: "engram_sk_test_old" }));
    chmodSync(join(ENGRAM, "config.json"), 0o644);
    await saveConfig({ apiKey: "engram_sk_test_new" });
    expect(mode(ENGRAM)).toBe(0o700);
    expect(mode(join(ENGRAM, "config.json"))).toBe(0o600);
    expect((await loadConfig()).apiKey).toBe("engram_sk_test_new");
  });

  it("a config.json save cut short leaves the old one whole, key and all", async () => {
    await saveConfig({ apiKey: "engram_sk_test_old", baseUrl: "http://127.0.0.1:9" });
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw errno("ENOSPC");
    });
    await expect(saveConfig({ apiKey: "engram_sk_test_new" })).rejects.toThrow("ENOSPC");
    expect(await loadConfig()).toEqual({ apiKey: "engram_sk_test_old", baseUrl: "http://127.0.0.1:9" });
    expect(temps(ENGRAM)).toEqual([]);
  });

  posixIt("vault keygen --save --force over a 0644 key: the new key and the backup are 0600", async () => {
    mkdirSync(ENGRAM, { mode: 0o700 });
    const keyFile = join(ENGRAM, "vault-key");
    const oldKey = Buffer.alloc(32, 7).toString("base64");
    writeFileSync(keyFile, oldKey + "\n");
    chmodSync(keyFile, 0o644);

    await vaultKeygen([], { save: "", force: "" });

    expect(mode(keyFile)).toBe(0o600);
    expect(readFileSync(keyFile, "utf-8").trim()).not.toBe(oldKey);
    const backups = readdirSync(ENGRAM).filter((name) => name.startsWith("vault-key.bak-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(ENGRAM, backups[0]), "utf-8").trim()).toBe(oldKey);
    expect(mode(join(ENGRAM, backups[0]))).toBe(0o600);
    expect(temps(ENGRAM)).toEqual([]);
  });

  posixIt("the log: created 0600, or set to 0600 with what it holds kept", () => {
    prepareLogSync();
    expect(mode(ENGRAM)).toBe(0o700);
    expect(mode(LOG_FILE)).toBe(0o600);

    writeFileSync(LOG_FILE, "earlier lines\n");
    chmodSync(LOG_FILE, 0o644);
    prepareLogSync();
    expect(mode(LOG_FILE)).toBe(0o600);
    expect(readFileSync(LOG_FILE, "utf-8")).toBe("earlier lines\n");
  });

  posixIt("daemon.db, new: it and its -wal and -shm files are 0600", () => {
    const path = join(ENGRAM, "daemon.db");
    const db = new DaemonDb(path);
    try {
      expect(mode(ENGRAM)).toBe(0o700);
      for (const file of [path, `${path}-wal`, `${path}-shm`]) {
        expect(existsSync(file), file).toBe(true);
        expect(mode(file), file).toBe(0o600);
      }
    } finally {
      db.close();
    }
  });

  posixIt("daemon.db from before the fix: set to 0600, with what it holds kept", () => {
    mkdirSync(ENGRAM, { mode: 0o755 });
    const path = join(ENGRAM, "daemon.db");
    // An older daemon's connection, which keeps the -wal and -shm files.
    const before = new Database(path);
    before.pragma("journal_mode = WAL");
    before.exec("CREATE TABLE earlier (x INTEGER)");
    before.prepare("INSERT INTO earlier VALUES (?)").run(1);
    const files = [path, `${path}-wal`, `${path}-shm`];
    for (const file of files) chmodSync(file, 0o644);

    const db = new DaemonDb(path);
    try {
      for (const file of files) expect(mode(file), file).toBe(0o600);
      before.prepare("INSERT INTO earlier VALUES (?)").run(2);
      expect(before.prepare("SELECT x FROM earlier ORDER BY x").all()).toEqual([{ x: 1 }, { x: 2 }]);
    } finally {
      db.close();
      before.close();
    }
  });
});

describe("launchd's log (engram#627)", () => {
  // launchd opens the log for the job before the worker runs, and creates a
  // missing one with the default 0644.
  posixIt("is there, 0600, when launchctl loads the job: engram install, and a plist update", async () => {
    expect(vi.isMockFunction(execSync)).toBe(true);
    onMac();
    const logModes: Array<number | null> = [];
    launchctl.mockImplementation(() => {
      logModes.push(existsSync(LOG_FILE) ? mode(LOG_FILE) : null);
      return Buffer.alloc(0);
    });

    await daemonInstall();
    expect(launchctl.mock.calls.map(([cmd]) => String(cmd).split(" ").slice(0, 2).join(" "))).toEqual([
      "launchctl load",
    ]);
    expect(logModes).toEqual([0o600]);
    expect(mode(ENGRAM)).toBe(0o700);

    // A plist from before the version stamp, and no log: it is rewritten
    // and loaded again.
    rmSync(LOG_FILE);
    writeFileSync(join(home.dir, "Library", "LaunchAgents", "app.getengram.daemon.plist"), "<plist></plist>");
    launchctl.mockClear();
    logModes.length = 0;
    expect(migrateLaunchdIfStale()).toBe(true);
    expect(logModes.length).toBeGreaterThan(0);
    expect(logModes.every((m) => m === 0o600)).toBe(true);
  });
});
