import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * engram#679 — a daemon.log the user can't write cost them capture: the
 * launcher couldn't open it, so `engram start` failed, and launchd never
 * starts a job whose log it can't open. The daemon doesn't need its log to
 * capture, and now runs without it. These check what that rests on: what
 * says whether the log can be written, and the launcher's start without
 * it. Real files, in a temp home; nothing is run.
 */

const { home, spawn } = vi.hoisted(() => ({ home: { dir: "" }, spawn: vi.fn() }));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn,
}));

home.dir = mkdtempSync(join(tmpdir(), "engram-679-"));
const ENGRAM = join(home.dir, ".engram");
/** A folder of the test's own that the user can't write in. */
const READ_ONLY = join(home.dir, "read-only");

// After the temp home is set: launch.ts takes its paths from it.
const { LOG_FILE, logProblem, spawnWorker } = await import("../daemon/launch.js");

afterAll(() => {
  for (const dir of [ENGRAM, READ_ONLY]) if (existsSync(dir)) chmodSync(dir, 0o700);
  rmSync(home.dir, { recursive: true, force: true });
});

const posixIt = process.platform === "win32" ? it.skip : it;
/** For a test of file permissions, which root and Windows don't keep to. */
const permissionsIt = process.platform === "win32" || process.getuid?.() === 0 ? it.skip : it;

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

beforeEach(() => {
  for (const dir of [ENGRAM, READ_ONLY]) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // not there, or a file
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("whether the daemon's log can be written (engram#679)", () => {
  it("can be when it is there and opens for writing, or isn't there yet and can be made, and nothing is made", () => {
    // No ~/.engram yet: the home lets it be made.
    expect(logProblem()).toBeNull();
    expect(existsSync(ENGRAM)).toBe(false);
    mkdirSync(ENGRAM, { mode: 0o700 });
    expect(logProblem()).toBeNull();
    expect(existsSync(LOG_FILE)).toBe(false);
    writeFileSync(LOG_FILE, "earlier lines\n", { mode: 0o600 });
    expect(logProblem()).toBeNull();
    expect(readFileSync(LOG_FILE, "utf-8")).toBe("earlier lines\n");
    // Another one, at the end of folders none of which are there.
    expect(logProblem(join(home.dir, "a", "b", "c", "daemon.log"))).toBeNull();
    expect(existsSync(join(home.dir, "a"))).toBe(false);
  });

  permissionsIt("can't be when the user's own is read-only, or the folder it would be made in is", () => {
    mkdirSync(ENGRAM, { mode: 0o700 });
    writeFileSync(LOG_FILE, "");
    chmodSync(LOG_FILE, 0o400);
    expect(logProblem()).toBe("EACCES");

    rmSync(LOG_FILE);
    chmodSync(ENGRAM, 0o500);
    expect(logProblem()).toBe("EACCES");
    // Nothing is changed to find out.
    expect(mode(ENGRAM)).toBe(0o500);

    // Folders that aren't there, under one that can't be written in.
    mkdirSync(READ_ONLY, { mode: 0o500 });
    expect(logProblem(join(READ_ONLY, "x", "y", "daemon.log"))).toBe("EACCES");
  });

  posixIt("can't be when a folder is in its place, or a file is in ~/.engram's", () => {
    mkdirSync(LOG_FILE, { recursive: true });
    expect(logProblem()).toBe("EISDIR");
    rmSync(ENGRAM, { recursive: true });
    writeFileSync(ENGRAM, "");
    expect(logProblem()).toBe("ENOTDIR");
    rmSync(ENGRAM);
  });

  posixIt("never waits on a FIFO in its place, which nothing reads", () => {
    mkdirSync(ENGRAM, { mode: 0o700 });
    execFileSync("mkfifo", [LOG_FILE]);
    // Opened without O_NONBLOCK, this would wait for a reader for ever.
    expect(logProblem()).toBe("ENXIO");
  });
});

describe("the daemon started without its log (engram#679)", () => {
  beforeEach(() => {
    spawn.mockReset().mockImplementation(() => Object.assign(new EventEmitter(), { pid: 4242, unref: vi.fn() }));
  });

  /** The options the launcher spawned the worker with. */
  function spawnedWith(): { stdio: unknown; detached?: boolean } {
    expect(spawn).toHaveBeenCalledTimes(1);
    return spawn.mock.calls[0][2] as { stdio: unknown; detached?: boolean };
  }

  posixIt("writes to its log when it can: made 0600 in ~/.engram 0700, and closed here once handed over", () => {
    spawnWorker();
    const { stdio, detached } = spawnedWith();
    expect(detached).toBe(true);
    expect(stdio).toEqual(["ignore", expect.any(Number), expect.any(Number)]);
    const [, out, err] = stdio as [string, number, number];
    expect(err).toBe(out);
    // The worker has its own handle on it: this process keeps none.
    expect(() => fstatSync(out)).toThrow(expect.objectContaining({ code: "EBADF" }));
    expect(mode(ENGRAM)).toBe(0o700);
    expect(mode(LOG_FILE)).toBe(0o600);
  });

  posixIt("makes a log others can read 0600 before the daemon writes to it, and keeps what it holds (engram#627)", () => {
    mkdirSync(ENGRAM, { mode: 0o700 });
    writeFileSync(LOG_FILE, "earlier lines\n");
    chmodSync(LOG_FILE, 0o644);
    spawnWorker();
    expect(spawnedWith().stdio).toEqual(["ignore", expect.any(Number), expect.any(Number)]);
    expect(mode(LOG_FILE)).toBe(0o600);
    expect(readFileSync(LOG_FILE, "utf-8")).toBe("earlier lines\n");
  });

  permissionsIt("drops its output while the log is read-only, and leaves the log as it is", () => {
    mkdirSync(ENGRAM, { mode: 0o700 });
    writeFileSync(LOG_FILE, "earlier lines\n");
    chmodSync(LOG_FILE, 0o400);
    spawnWorker();
    expect(spawnedWith().stdio).toBe("ignore");
    expect(mode(LOG_FILE)).toBe(0o400);
    expect(readFileSync(LOG_FILE, "utf-8")).toBe("earlier lines\n");
  });

  permissionsIt("drops its output while ~/.engram doesn't let the log be made", () => {
    mkdirSync(ENGRAM, { mode: 0o700 });
    chmodSync(ENGRAM, 0o500);
    spawnWorker();
    expect(spawnedWith().stdio).toBe("ignore");
    expect(existsSync(LOG_FILE)).toBe(false);
    expect(mode(ENGRAM)).toBe(0o500);
  });

  posixIt("starts nothing when ~/.engram can't be made: nothing runs without it", () => {
    writeFileSync(ENGRAM, "");
    expect(() => spawnWorker()).toThrow();
    expect(spawn).not.toHaveBeenCalled();
    rmSync(ENGRAM);
  });
});
