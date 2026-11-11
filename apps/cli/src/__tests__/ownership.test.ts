import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, constants, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  foreignFiles,
  foreignFilesFix,
  foreignFilesProblem,
  lockedDir,
  lockedDirFix,
  lockedDirProblem,
  lockedDirReason,
  OWNERSHIP_FIX,
  type ForeignFiles,
  type LockedDir,
  type OwnershipCheck,
} from "../daemon/ownership.js";

/**
 * engram#659 — files in ~/.engram that aren't the user's, as `sudo engram …`
 * leaves them.
 *
 * Owners and access are given, not made: making a file another user's takes
 * root, and nothing here runs as root or changes an owner. One test at the
 * end looks at a real temp directory, as a user other than its owner.
 */

const { R_OK, W_OK, X_OK } = constants;
const ME = 501;
const ROOT = 0;
const OTHER = 502;

const tmp = mkdtempSync(join(tmpdir(), "engram-659o-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Never looked at: owners and access come from the table. */
const DIR = join(tmp, "given", ".engram");

/** Who owns a file, and what this user can't do to it. */
interface Given {
  uid: number;
  deny?: number;
}

const mine: Given = { uid: ME };
/** Root's and 0600: what `sudo engram …` leaves. */
const roots: Given = { uid: ROOT, deny: R_OK | W_OK | X_OK };
/** Root's and 0644. */
const rootsReadable: Given = { uid: ROOT, deny: W_OK | X_OK };

/** foreignFiles on a ~/.engram given as a table: "." is the folder. */
function check(files: Record<string, Given>, options: OwnershipCheck = {}): ForeignFiles | null {
  const at = (path: string): Given | undefined => (path === DIR ? files["."] : files[basename(path)]);
  return foreignFiles({
    platform: "darwin",
    euid: ME,
    env: {},
    dir: DIR,
    ownerOf: (path) => at(path)?.uid ?? null,
    canAccess: (path, mode) => ((at(path)?.deny ?? 0) & mode) === 0,
    ...options,
  });
}

const ALL = [
  "daemon.db",
  "daemon.db-wal",
  "daemon.db-shm",
  "config.json",
  "vault-key",
  "daemon.log",
  "status.json",
  "daemon.pid",
  "daemon.sock",
];

describe("foreignFiles (engram#659)", () => {
  it("finds nothing when everything in ~/.engram is the user's", () => {
    expect(check(Object.fromEntries([[".", mine], ...ALL.map((name) => [name, mine])]))).toBeNull();
  });

  it("finds nothing before ~/.engram is made", () => {
    expect(check({ "daemon.db": roots })).toBeNull();
  });

  it("never looks on Windows, as root, or with no effective uid", () => {
    const files = { ".": mine, "daemon.db": roots };
    expect(check(files)).not.toBeNull();
    expect(check(files, { platform: "win32" })).toBeNull();
    expect(check(files, { euid: 0 })).toBeNull();
    // To root, even the user's own socket would be another user's.
    expect(check({ ".": mine, "daemon.sock": mine }, { euid: 0 })).toBeNull();
    expect(check(files, { euid: null })).toBeNull();
  });

  it.each(["daemon.db", "daemon.db-wal", "daemon.db-shm"])("finds a root-owned %s stops the daemon", (name) => {
    expect(check({ ".": mine, [name]: roots })).toEqual({
      dir: false,
      files: [name],
      root: true,
      stopsDaemon: true,
      holdsSends: false,
    });
    // SQLite opens it to write, too.
    expect(check({ ".": mine, [name]: rootsReadable })?.stopsDaemon).toBe(true);
  });

  it("doesn't count a file another user owns that this user can use all the same", () => {
    // A network home that maps owners wrongly, or root's and 0666.
    expect(check({ ".": mine, "daemon.db": { uid: ROOT }, "config.json": { uid: OTHER } })).toBeNull();
  });

  it("never counts the user's own folder or files, whatever their mode", () => {
    // No chown makes them usable: they aren't someone else's.
    const closed: Given = { uid: ME, deny: R_OK | W_OK | X_OK };
    expect(check({ ".": closed, "daemon.db": { uid: ME, deny: R_OK | W_OK }, "config.json": { uid: ME, deny: R_OK } })).toBeNull();
  });

  it("finds an unreadable config.json stops the daemon, even with ENGRAM_API_KEY set (engram#673)", () => {
    const found = check({ ".": mine, "config.json": roots }, { env: { ENGRAM_API_KEY: "egm_test" } });
    expect(found).toMatchObject({ files: ["config.json"], stopsDaemon: true });
  });

  it("finds a config.json it can read but not update a warning", () => {
    const found = check({ ".": mine, "config.json": rootsReadable });
    expect(found).toMatchObject({ files: ["config.json"], stopsDaemon: false });
    expect(foreignFilesProblem(found!)).toBe(
      "config.json in ~/.engram belongs to root, not to you, so Engram can't update it.",
    );
  });

  it("finds an unreadable vault-key holds sends, and doesn't stop the daemon (engram#695)", () => {
    const found = check({ ".": mine, "vault-key": roots });
    expect(found).toEqual({
      dir: false,
      files: ["vault-key"],
      root: true,
      stopsDaemon: false,
      holdsSends: true,
    });
    // Whether the daemon runs or not: one that runs captures, and sends
    // nothing until then.
    for (const daemon of ["running", "stopped", undefined] as const) {
      expect(foreignFilesProblem(found!, daemon)).toBe(
        "vault-key in ~/.engram belongs to root, not to you. Until it is yours, captured messages wait " +
          "on this machine: nothing is lost.",
      );
    }
    expect(foreignFilesFix(found!)).toBe(`Make it yours with: ${OWNERSHIP_FIX}`);

    // One it can't read, though it could write it: the hold is what counts.
    const writable = check({ ".": mine, "vault-key": { uid: ROOT, deny: R_OK } });
    expect(writable).toMatchObject({ files: ["vault-key"], stopsDaemon: false, holdsSends: true });
  });

  it("finds a vault-key that holds nothing while ENGRAM_VAULT_KEY is set, or that it can read, a warning", () => {
    // ENGRAM_VAULT_KEY set: the file isn't read, but still can't be updated.
    expect(check({ ".": mine, "vault-key": roots }, { env: { ENGRAM_VAULT_KEY: "k" } })).toEqual({
      dir: false,
      files: ["vault-key"],
      root: true,
      stopsDaemon: false,
      holdsSends: false,
    });
    const readable = check({ ".": mine, "vault-key": rootsReadable });
    expect(readable).toMatchObject({ files: ["vault-key"], stopsDaemon: false, holdsSends: false });
    expect(foreignFilesProblem(readable!)).toBe(
      "vault-key in ~/.engram belongs to root, not to you, so Engram can't update it.",
    );
  });

  it("says what stops the daemon rather than what holds its sends", () => {
    const both = check({ ".": mine, "daemon.db": roots, "vault-key": roots });
    expect(both).toMatchObject({ files: ["daemon.db", "vault-key"], stopsDaemon: true, holdsSends: true });
    expect(foreignFilesProblem(both!, "stopped")).toBe(
      "daemon.db and vault-key in ~/.engram belong to root, not to you, so the daemon can't start, " +
        "and nothing new is captured.",
    );
    // A hold, with a file that only warns: both are made the user's.
    const many = check({ ".": mine, "vault-key": roots, "status.json": roots });
    expect(many).toMatchObject({ files: ["vault-key", "status.json"], stopsDaemon: false, holdsSends: true });
    expect(foreignFilesProblem(many!)).toBe(
      "vault-key and status.json in ~/.engram belong to root, not to you. Until they are yours, captured " +
        "messages wait on this machine: nothing is lost.",
    );
    expect(foreignFilesFix(many!)).toBe(`Make them yours with: ${OWNERSHIP_FIX}`);
  });

  it("finds an unwritable daemon.log a warning: the daemon runs without its log (engram#679)", () => {
    const found = check({ ".": mine, "daemon.log": rootsReadable });
    expect(found).toEqual({ dir: false, files: ["daemon.log"], root: true, stopsDaemon: false, holdsSends: false });
    expect(foreignFilesProblem(found!)).toBe("daemon.log in ~/.engram belongs to root, not to you, so the daemon can't write its log.");
    expect(foreignFilesFix(found!)).toBe(`Make it yours with: ${OWNERSHIP_FIX}`);
    // With another that only warns, said the way that one is.
    const more = check({ ".": mine, "daemon.log": roots, "status.json": roots });
    expect(foreignFilesProblem(more!)).toBe(
      "daemon.log and status.json in ~/.engram belong to root, not to you, so Engram can't update them.",
    );
    // With what holds sends, the hold is said.
    const held = check({ ".": mine, "vault-key": roots, "daemon.log": roots });
    expect(foreignFilesProblem(held!)).toBe(
      "vault-key and daemon.log in ~/.engram belong to root, not to you. Until they are yours, captured " +
        "messages wait on this machine: nothing is lost.",
    );
    // Root's, and one it can write: not counted.
    expect(check({ ".": mine, "daemon.log": { uid: ROOT } })).toBeNull();
  });

  it("finds status.json and daemon.pid it can't update warnings", () => {
    const found = check({ ".": mine, "status.json": rootsReadable, "daemon.pid": roots });
    expect(found).toMatchObject({ files: ["status.json", "daemon.pid"], stopsDaemon: false });
    expect(foreignFilesProblem(found!)).toBe(
      "status.json and daemon.pid in ~/.engram belong to root, not to you, so Engram can't update them.",
    );
    expect(foreignFilesFix(found!)).toBe(`Make them yours with: ${OWNERSHIP_FIX}`);
  });

  it("finds another user's socket stops the daemon, whatever its mode (engram#612)", () => {
    const found = check({ ".": mine, "daemon.sock": { uid: OTHER } });
    expect(found).toEqual({
      dir: false,
      files: ["daemon.sock"],
      root: false,
      stopsDaemon: true,
      holdsSends: false,
    });
    expect(foreignFilesProblem(found!, "stopped")).toBe(
      "daemon.sock in ~/.engram belongs to another user, not to you, so the daemon can't start, and nothing new is captured.",
    );
  });

  it("finds ~/.engram itself, when it is root's and closed to the user", () => {
    const found = check({ ".": roots, "daemon.db": mine });
    expect(found).toEqual({ dir: true, files: [], root: true, stopsDaemon: true, holdsSends: false });
    expect(foreignFilesProblem(found!)).toBe("~/.engram belongs to root, not to you, so the daemon can't start.");
    expect(foreignFilesFix(found!)).toBe(`Make it yours with: ${OWNERSHIP_FIX}`);
    // Open to the user, it is only a folder: what is in it is looked at.
    expect(check({ ".": { uid: ROOT }, "daemon.db": mine })).toBeNull();
    expect(check({ ".": { uid: ROOT }, "daemon.db": roots })).toMatchObject({ dir: false, files: ["daemon.db"] });
  });

  it("says root only when root owns every one of them", () => {
    const found = check({ ".": mine, "daemon.db": roots, "config.json": { uid: OTHER, deny: R_OK } });
    expect(found).toMatchObject({ files: ["daemon.db", "config.json"], root: false });
    expect(foreignFilesProblem(found!, "stopped")).toBe(
      "daemon.db and config.json in ~/.engram belong to another user, not to you, so the daemon can't start, and nothing new is captured.",
    );
  });

  it("names them in order, and no more than four", () => {
    const every = check(Object.fromEntries([[".", mine], ...ALL.map((name) => [name, roots])]));
    expect(every?.files).toEqual(ALL);
    expect(every).toMatchObject({ root: true, stopsDaemon: true, holdsSends: true });
    expect(foreignFilesProblem(every!, "running")).toBe(
      "daemon.db, daemon.db-wal, daemon.db-shm and 6 more in ~/.engram belong to root, not to you, " +
        "so the daemon can't start again once it stops.",
    );
    const four = check({ ".": mine, "vault-key": rootsReadable, "status.json": roots, "daemon.pid": roots, "config.json": rootsReadable });
    expect(foreignFilesProblem(four!)).toBe(
      "config.json, vault-key, status.json and daemon.pid in ~/.engram belong to root, not to you, so Engram can't update them.",
    );
  });

  it("says what they stop by whether the daemon runs, where that is known", () => {
    const db = check({ ".": mine, "daemon.db": roots });
    const IS = "daemon.db in ~/.engram belongs to root, not to you, so";
    expect(foreignFilesProblem(db!, "stopped")).toBe(`${IS} the daemon can't start, and nothing new is captured.`);
    // Started before they were root's: it captures until it stops.
    expect(foreignFilesProblem(db!, "running")).toBe(`${IS} the daemon can't start again once it stops.`);
    expect(foreignFilesProblem(db!)).toBe(`${IS} the daemon can't start.`);
    // What only warns doesn't depend on it: daemon.log among them, which
    // used to stop a start (engram#679).
    const status = check({ ".": mine, "status.json": roots });
    const log = check({ ".": mine, "daemon.log": roots });
    for (const daemon of ["running", "stopped", undefined] as const) {
      expect(foreignFilesProblem(status!, daemon)).toBe(
        "status.json in ~/.engram belongs to root, not to you, so Engram can't update it.",
      );
      expect(foreignFilesProblem(log!, daemon)).toBe(
        "daemon.log in ~/.engram belongs to root, not to you, so the daemon can't write its log.",
      );
    }
  });

  it("gives the fix as a command the user's own shell fills in", () => {
    // The shell expands "$(id -un)" and ~ before sudo runs: the user's name
    // and home, not root's.
    expect(OWNERSHIP_FIX).toBe('sudo chown -R "$(id -un)" ~/.engram');
  });

  it("looks at a real folder, by owner and by access", () => {
    const dir = join(tmp, "real", ".engram");
    mkdirSync(dir, { recursive: true });
    for (const name of ["daemon.db", "config.json", "status.json", "daemon.sock"]) writeFileSync(join(dir, name), "");
    expect(foreignFiles({ dir, platform: "linux" })).toBeNull();
    // As someone else: this user can still use every one of them, so only
    // the socket counts, which is never taken for the daemon's. (Windows
    // gives every file owner 0.)
    const owner = statSync(dir).uid;
    const asOther = foreignFiles({ dir, platform: "linux", euid: owner + 1000 });
    expect(asOther).toMatchObject({ dir: false, files: ["daemon.sock"], root: owner === 0, stopsDaemon: true });
    // Nothing there: not looked at.
    expect(foreignFiles({ dir: join(tmp, "none", ".engram"), platform: "linux", euid: owner + 1000 })).toBeNull();
  });

  // Root can use any file, whatever its mode.
  it.skipIf(process.geteuid?.() === 0)("goes by what this user can do to a real file", () => {
    // The user's own, with every permission taken off, looked at as someone
    // else: counted, because this user can't use it. (On Windows, this sets
    // the read-only flag.)
    const dir = join(tmp, "closed", ".engram");
    mkdirSync(dir, { recursive: true });
    const db = join(dir, "daemon.db");
    writeFileSync(db, "");
    chmodSync(db, 0o000);
    try {
      const owner = statSync(dir).uid;
      expect(foreignFiles({ dir, platform: "linux", euid: owner + 1000 })).toMatchObject({
        dir: false,
        files: ["daemon.db"],
        stopsDaemon: true,
      });
    } finally {
      chmodSync(db, 0o600);
    }
  });
});

/**
 * engram#723 — a ~/.engram that is the user's, and that its own permissions
 * keep them out of, as `chmod -R 600 ~/.engram` leaves it.
 */
describe("lockedDir (engram#723)", () => {
  /**
   * lockedDir on a ~/.engram of the user's with permission bits `mode`:
   * what this user can do to it goes by the owner's bits, unless `options`
   * says otherwise.
   */
  function lockedAt(mode: number | null, options: OwnershipCheck = {}): LockedDir | null {
    return lockedDir({
      platform: "darwin",
      euid: ME,
      dir: DIR,
      ownerOf: () => ME,
      modeOf: () => mode,
      canAccess: (_path, want) => mode !== null && (mode & (want << 6)) === want << 6,
      ...options,
    });
  }

  const SEARCH: LockedDir = { search: true, write: false, command: "chmod u+x ~/.engram" };
  const WRITE: LockedDir = { search: false, write: true, command: "chmod u+w ~/.engram" };

  it("finds nothing when the user can open and make files in ~/.engram", () => {
    for (const mode of [0o700, 0o755, 0o711, 0o777]) expect(lockedAt(mode), mode.toString(8)).toBeNull();
  });

  it("doesn't count a folder that only can't be listed: nothing needs that but the daemon's tidy-up", () => {
    expect(lockedAt(0o300)).toBeNull();
    expect(lockedAt(0o311)).toBeNull();
  });

  it("finds a folder that can't be searched, and gives back only the bits that are missing", () => {
    expect(lockedAt(0o600)).toEqual(SEARCH);
    expect(lockedAt(0o644)).toEqual(SEARCH);
    expect(lockedAt(0o200)).toEqual({ search: true, write: false, command: "chmod u+rx ~/.engram" });
    // Neither: the search lock is the one that says what fails.
    expect(lockedAt(0o400)).toEqual({ search: true, write: true, command: "chmod u+wx ~/.engram" });
    expect(lockedAt(0o000)).toEqual({ search: true, write: true, command: "chmod u+rwx ~/.engram" });
  });

  it("finds a folder nothing can be made in", () => {
    expect(lockedAt(0o500)).toEqual(WRITE);
    expect(lockedAt(0o555)).toEqual(WRITE);
    expect(lockedAt(0o100)).toEqual({ search: false, write: true, command: "chmod u+rw ~/.engram" });
  });

  it("never looks on Windows, as root, or with no effective uid", () => {
    expect(lockedAt(0o000, { platform: "win32" })).toBeNull();
    expect(lockedAt(0o000, { euid: ROOT })).toBeNull();
    // Nor in one root owns, whatever access says: no mode keeps root out.
    expect(lockedAt(0o000, { euid: ROOT, ownerOf: () => ROOT })).toBeNull();
    expect(lockedAt(0o000, { euid: null })).toBeNull();
  });

  it("leaves a folder that isn't the user's, or isn't there, to foreignFiles", () => {
    expect(lockedAt(0o000, { ownerOf: () => ROOT })).toBeNull();
    expect(lockedAt(0o000, { ownerOf: () => OTHER })).toBeNull();
    expect(lockedAt(0o000, { ownerOf: () => null })).toBeNull();
    expect(lockedAt(null)).toBeNull();
  });

  it("counts only what the owner's bits keep from the user, which a chmod of the folder fixes", () => {
    // An ACL that gives the user what the bits don't: nothing is in the way.
    expect(lockedAt(0o600, { canAccess: () => true })).toBeNull();
    expect(lockedAt(0o500, { canAccess: () => true })).toBeNull();
    // Kept out with every bit set (an ACL, a read-only disk): no chmod fixes that.
    expect(lockedAt(0o700, { canAccess: () => false })).toBeNull();
  });

  it("says what the permissions keep the user from, and what that stops, by whether the daemon runs", () => {
    const opening = "~/.engram is yours, but its permissions keep you from opening the files in it";
    const making = "~/.engram is yours, but its permissions keep you from making files in it";
    expect(lockedDirProblem(SEARCH)).toBe(`${opening}, so the daemon can't start.`);
    expect(lockedDirProblem(SEARCH, "stopped")).toBe(`${opening}, so the daemon can't start, and nothing new is captured.`);
    expect(lockedDirProblem(SEARCH, "running")).toBe(
      `${opening}, so capture is paused, and the daemon can't start again once it stops.`,
    );
    expect(lockedDirProblem(WRITE)).toBe(`${making}, so the daemon can't start.`);
    expect(lockedDirProblem(WRITE, "stopped")).toBe(`${making}, so the daemon can't start, and nothing new is captured.`);
    expect(lockedDirProblem(WRITE, "running")).toBe(`${making}, so the daemon can't start again once it stops.`);
    expect(lockedDirProblem({ search: true, write: true, command: "chmod u+wx ~/.engram" }, "stopped")).toBe(
      `${opening}, so the daemon can't start, and nothing new is captured.`,
    );
  });

  it("gives the fix as the command, and says why a file couldn't be opened", () => {
    expect(lockedDirFix(SEARCH)).toBe("To fix it, run: chmod u+x ~/.engram");
    expect(lockedDirFix(WRITE)).toBe("To fix it, run: chmod u+w ~/.engram");
    expect(lockedDirReason("opening config.json")).toBe("~/.engram's permissions keep you from opening config.json in it");
  });

  // Root can open any folder, whatever its mode; Windows has no such bits.
  it.skipIf(process.platform === "win32" || process.geteuid?.() === 0)(
    "looks at a real folder, by its mode and by access",
    () => {
      const dir = join(tmp, "locked", ".engram");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "config.json"), "{}");
      const cases: [number, LockedDir | null][] = [
        [0o700, null],
        [0o300, null],
        [0o600, SEARCH],
        [0o500, WRITE],
        [0o400, { search: true, write: true, command: "chmod u+wx ~/.engram" }],
        [0o000, { search: true, write: true, command: "chmod u+rwx ~/.engram" }],
      ];
      try {
        for (const [mode, expected] of cases) {
          chmodSync(dir, mode);
          expect(lockedDir({ dir, platform: "linux" }), mode.toString(8)).toEqual(expected);
        }
      } finally {
        chmodSync(dir, 0o700);
      }
      // Each command, run, leaves nothing in the way.
      const BITS = { r: 0o400, w: 0o200, x: 0o100 } as const;
      for (const [mode, expected] of cases) {
        if (expected === null) continue;
        const letters = /^chmod u\+([rwx]+) ~\/\.engram$/.exec(expected.command)?.[1] ?? "";
        const added = [...letters].reduce((bits, letter) => bits | BITS[letter as keyof typeof BITS], 0);
        chmodSync(dir, mode | added);
        try {
          expect(statSync(dir).mode & 0o700, mode.toString(8)).toBe(0o700);
          expect(lockedDir({ dir, platform: "linux" }), mode.toString(8)).toBeNull();
        } finally {
          chmodSync(dir, 0o700);
        }
      }
    },
  );
});
