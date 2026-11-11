/**
 * ~/.engram holds the API key, the vault key, and the daemon's queue of
 * captured transcript text. On macOS and Linux it is the user's alone
 * (engram#627): the directory is 0700 and the files in it 0600, as Claude
 * Code keeps the transcripts themselves. It used to get the defaults, 0755
 * and 0644 under the usual umask, so other accounts on the machine could
 * read the daemon's copy of transcripts they couldn't read at the source.
 *
 * Windows is left alone: files under the user profile inherit its ACL,
 * which is private already. Writes there are still atomic.
 *
 * IMPORTANT: Node built-ins only. launch.ts uses this module, and the
 * Windows sign-in entry runs launch.ts before the daemon's native-module
 * preflight (see launch.ts).
 */

import { randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  chownSync,
  closeSync,
  constants,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/** The group and other permission bits, which private clears. */
const SHARED_BITS = 0o077;

/** `mode` with the group and other bits cleared, and the owner's kept. */
function unshared(mode: number): number {
  return mode & 0o7777 & ~SHARED_BITS;
}

function posix(): boolean {
  return process.platform !== "win32";
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

/**
 * Whether this process owns `st`. Only what the user owns is changed: root
 * could change anyone's file, but another user's stays as it is.
 */
function ours(st: { uid: number | bigint }): boolean {
  return Number(st.uid) === process.geteuid?.();
}

/**
 * Root writing into another user's ~/.engram (sudo keeps HOME on some
 * systems): what it creates there goes to the owner of the directory it is
 * created in. Otherwise the user's own CLI and daemon couldn't read a
 * config.json that `sudo engram …` had written. An in-place write left the
 * file's owner as it was; the rename that replaced it would not.
 */
function ownerFor(dir: string): { uid: number; gid: number } | null {
  if (!posix() || process.geteuid?.() !== 0) return null;
  const st = statSync(dir);
  return st.uid === 0 ? null : { uid: st.uid, gid: st.gid };
}

/**
 * Make sure `dir` exists and is private: created 0700, or, when it is
 * already there and the user's own, its group and other bits cleared, so an
 * install from before engram#627 is covered too. Returns what was done.
 *
 * Only for a directory that is Engram's alone (~/.engram), never one that
 * other things share.
 */
export function ensurePrivateDirSync(dir: string): "created" | "changed" | "private" | "not-ours" {
  const created = mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE }) !== undefined;
  if (!posix()) return created ? "created" : "private";
  if (created) {
    const owner = ownerFor(dirname(dir));
    if (owner) chownSync(dir, owner.uid, owner.gid);
  }
  const st = statSync(dir);
  if ((st.mode & SHARED_BITS) === 0) return created ? "created" : "private";
  if (!ours(st)) return "not-ours";
  chmodSync(dir, unshared(st.mode));
  return created ? "created" : "changed";
}

/**
 * Clear the group and other bits of the file at `path` when it is the
 * user's own. Best effort, and never throws: a mode that can't be changed
 * (a filesystem without them) mustn't stop capture.
 *
 * Path-based on purpose. Opening and closing a SQLite database file here
 * would drop the locks this process holds on it through SQLite.
 */
export function restrictSync(path: string): "changed" | "private" | "missing" | "not-ours" | "failed" {
  if (!posix()) return "private";
  try {
    const st = statSync(path);
    if ((st.mode & SHARED_BITS) === 0) return "private";
    if (!ours(st)) return "not-ours";
    chmodSync(path, unshared(st.mode));
    return "changed";
  } catch (err) {
    return errCode(err) === "ENOENT" ? "missing" : "failed";
  }
}

/**
 * Create an empty file at `path`, 0600, unless something is there already.
 * For daemon.db: SQLite gives its -wal and -shm files the database file's
 * mode, and treats an empty file as an empty database.
 */
export function createPrivateFileSync(path: string): void {
  try {
    closeSync(openSync(path, "wx", PRIVATE_FILE_MODE));
  } catch (err) {
    if (errCode(err) !== "EEXIST") throw err;
  }
}

/** `<name>.<pid>.<8 hex digits>.tmp`: one per write, so two writers never share one. */
function tempName(name: string): string {
  return `${name}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
}

/** A temp file of tempName's, and the name of the file it was for. */
const TEMP_FILE = /^(.+)\.\d+\.[0-9a-f]{8}\.tmp$/;

/**
 * Waits before each retry of a rename Windows refused because another
 * program has the old file open without sharing it (an antivirus scan, an
 * editor). About 300 ms in all.
 */
const WINDOWS_RENAME_RETRY_MS = [10, 20, 40, 80, 160];

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameRetryingSync(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = errCode(err);
      const busy = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (posix() || !busy || attempt >= WINDOWS_RENAME_RETRY_MS.length) throw err;
      sleepSync(WINDOWS_RENAME_RETRY_MS[attempt]);
    }
  }
}

/** Best effort: makes a rename survive a power cut. Not every filesystem allows it. */
function syncDirSync(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // the rename stands either way
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // nothing left to do
      }
    }
  }
}

export interface PrivateWriteOptions {
  /**
   * Flush the new content to disk before it replaces the old (default).
   * status.json, rewritten every few seconds and of no use after a power
   * cut, skips it.
   */
  durable?: boolean;
}

/**
 * Replace `file` with `data` in one step (engram#627): `data` goes to a
 * 0600 temp file beside it, which is then renamed over the old one. A
 * reader sees the old content or the new, never part of either, and a
 * crash or a full disk in the middle leaves the old file whole.
 * config.json used to be rewritten in place, so a write cut short left it
 * truncated and lost the API key and baseUrl.
 *
 * A symlink is written through, to the file it points at. A file this
 * process couldn't have written in place isn't replaced either (EACCES,
 * as an in-place write would have thrown): the rename needs only the
 * directory's permission.
 */
export function writePrivateFileSync(file: string, data: string, options: PrivateWriteOptions = {}): void {
  const durable = options.durable ?? true;
  let target = file;
  try {
    target = realpathSync(file);
  } catch (err) {
    if (errCode(err) !== "ENOENT") throw err;
  }
  try {
    accessSync(target, constants.W_OK);
  } catch (err) {
    if (errCode(err) !== "ENOENT") throw err;
  }
  const dir = dirname(target);
  const tmp = join(dir, tempName(basename(target)));
  // "wx": a name that is somehow taken already fails here, before anything
  // that would remove a file this call didn't create.
  const fd = openSync(tmp, "wx", PRIVATE_FILE_MODE);
  let renamed = false;
  try {
    try {
      const owner = ownerFor(dir);
      if (owner) fchownSync(fd, owner.uid, owner.gid);
      writeFileSync(fd, data);
      if (durable) fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameRetryingSync(tmp, target);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        unlinkSync(tmp);
      } catch {
        // already gone
      }
    }
  }
  if (durable && posix()) syncDirSync(dir);
}

/**
 * Throw what writePrivateFileSync(file, …) would for a file, or a folder,
 * this process can't write, but write nothing (engram#717). For a command
 * that does what can't be undone before it saves: `engram login` makes a
 * new API key, and a save that then fails loses it. A full disk is found
 * only by writing.
 */
export function checkWritableSync(file: string): void {
  let target = file;
  try {
    target = realpathSync(file);
  } catch (err) {
    if (errCode(err) !== "ENOENT") throw err;
  }
  try {
    accessSync(target, constants.W_OK);
  } catch (err) {
    if (errCode(err) !== "ENOENT") throw err;
  }
  // The new file is made in its folder, and a folder that isn't there yet
  // in the nearest one that is (ensurePrivateDirSync).
  for (let dir = dirname(target); ; dir = dirname(dir)) {
    try {
      accessSync(dir, constants.W_OK | constants.X_OK);
      return;
    } catch (err) {
      if (errCode(err) !== "ENOENT" || dirname(dir) === dir) throw err;
    }
  }
}

export interface SmallFile {
  data: Buffer;
  /**
   * Which write of the file this is: its device, inode, modification time
   * and size. writePrivateFileSync writes a new file every time, so a new
   * write almost always differs from the last; a file system can give the
   * new file the old one's inode, and the same time when its clock is
   * coarse.
   */
  stamp: string;
}

/**
 * A small file read without waiting: null when there is none, it can't be
 * read, or it isn't a regular file of at most `maxBytes`. It is opened
 * without blocking and checked before it is read: a FIFO put in its place
 * would otherwise hang the reader. BigInt fstat: a plain stat fills the
 * buffer Node's module loader reads (see lstatSocketPath in
 * daemon/instance.ts).
 */
export function readSmallFileSync(file: string, maxBytes: number): SmallFile | null {
  let fd: number;
  try {
    // O_NONBLOCK: undefined on Windows, which has no FIFOs in the file system.
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile() || st.size > BigInt(maxBytes)) return null;
    const buf = Buffer.alloc(maxBytes + 1);
    const read = readSync(fd, buf, 0, buf.length, 0);
    return { data: buf.subarray(0, read), stamp: `${st.dev}:${st.ino}:${st.mtimeNs}:${st.size}` };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Only these temp files are ever removed: the rest of ~/.engram is left as it is. */
const TEMP_FILES_FOR = new Set(["config.json", "status.json", "daemon.pid", "daemon.stop", "vault-changed"]);

/**
 * How old a leftover temp file must be before it is removed. A write in
 * progress, such as the CLI saving config.json as the daemon starts, has
 * its temp file for a few milliseconds.
 */
export const STALE_TEMP_MS = 10 * 60_000;

export interface PrivateDirReport {
  dir: "created" | "changed" | "private" | "not-ours";
  /** Files whose group and other bits were cleared. */
  changed: string[];
  /** Files left as they were: another user's, or the change failed. */
  skipped: string[];
  /** Temp files of config.json, status.json, daemon.pid, daemon.stop and vault-changed that a write cut short left behind. */
  removed: string[];
  /**
   * Why `dir` couldn't be listed ("EACCES"), when it couldn't: its files
   * were then left as they are (engram#723).
   */
  unlisted?: string;
}

/**
 * At the daemon's start (engram#627): `dir` made private, and every
 * regular file directly in it set to 0600, so an install from before this
 * fix is covered as well as a new one. Symlinks and subdirectories are left
 * alone, so nothing outside `dir` changes. Temp files that an interrupted
 * write of config.json, status.json, daemon.pid, daemon.stop or
 * vault-changed left behind are removed once they are STALE_TEMP_MS old.
 *
 * Throws only when `dir` can't be created or looked at. One that can't be
 * listed, as a `chmod u-r` leaves it, has its files left as they are, and
 * `unlisted` says why (engram#723): the daemon needs to open its files, not
 * to list them, so that is no reason for it not to start.
 */
export function makeDirPrivateSync(dir: string, now = Date.now()): PrivateDirReport {
  const report: PrivateDirReport = { dir: ensurePrivateDirSync(dir), changed: [], skipped: [], removed: [] };
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    report.unlisted = (err as NodeJS.ErrnoException).code ?? "unknown error";
    return report;
  }
  for (const name of names) {
    const path = join(dir, name);
    let st: BigIntStats;
    try {
      // BigInt fields: the daemon's socket is in ~/.engram, and a plain
      // stat of a socket throws off how Node loads modules after it (see
      // lstatSocketPath in daemon/instance.ts).
      st = lstatSync(path, { bigint: true });
    } catch {
      continue; // gone since the listing
    }
    if (!st.isFile()) continue;
    const mode = Number(st.mode);
    const temp = TEMP_FILE.exec(name);
    if (temp && TEMP_FILES_FOR.has(temp[1]) && now - Number(st.mtimeMs) >= STALE_TEMP_MS) {
      try {
        unlinkSync(path);
        report.removed.push(name);
        continue;
      } catch {
        // restricted below, like any other file
      }
    }
    if (!posix() || (mode & SHARED_BITS) === 0) continue;
    if (!ours(st)) {
      report.skipped.push(name);
      continue;
    }
    try {
      chmodSync(path, unshared(mode));
      report.changed.push(name);
    } catch {
      report.skipped.push(name);
    }
  }
  return report;
}
