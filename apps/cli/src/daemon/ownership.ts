/**
 * engram#659 — files in ~/.engram that aren't the user's. engram#723 — a
 * ~/.engram that is the user's, and that its own permissions keep them out
 * of (lockedDir).
 *
 * Run with sudo, a CLI from before engram#653 started the daemon as root
 * and wrote config.json as root. What root makes in the user's ~/.engram is
 * root's, and 0600: the user's own daemon can't open its database or read
 * config.json, and the CLI can't update them. The daemon used to fail on
 * the first such file and exit with an error. launchd and systemd started
 * it again a few seconds later, and again, for good, and nothing the user
 * would look at said why.
 *
 * This finds them and says what they stop, or hold. It never changes an
 * owner: that takes root, and is the user's to run (OWNERSHIP_FIX).
 *
 * Node built-ins only.
 */

import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Makes everything in ~/.engram the user's again. */
export const OWNERSHIP_FIX = 'sudo chown -R "$(id -un)" ~/.engram';

const { R_OK, W_OK, X_OK } = constants;

/** A file in ~/.engram, and what one that isn't the user's gets in the way of. */
interface Watched {
  name: string;
  /**
   * Without this access to it, the daemon can't run. "always": whatever the
   * access. Not while `unlessEnv` is set.
   */
  stops?: { mode: number | "always"; unlessEnv?: string };
  /**
   * Without this access to it, the daemon runs, but sends nothing: what it
   * captures waits on this machine. Not while `unlessEnv` is set.
   */
  holds?: { mode: number; unlessEnv?: string };
  /** Without this access, Engram can't update it: a warning. */
  warns?: number;
}

/** In the order they are named. */
const WATCHED: Watched[] = [
  // The queue of captured messages. SQLite opens the database, and the -wal
  // and -shm beside it, to read and write.
  { name: "daemon.db", stops: { mode: R_OK | W_OK } },
  { name: "daemon.db-wal", stops: { mode: R_OK | W_OK } },
  { name: "daemon.db-shm", stops: { mode: R_OK | W_OK } },
  // The API key, and the paths `engram exclude add` keeps out of capture.
  // Even with ENGRAM_API_KEY set: unread, the exclusions would be lost, and
  // the sessions they keep out captured (engram#673).
  { name: "config.json", stops: { mode: R_OK }, warns: W_OK },
  // The vault key. One that can't be read holds sends, rather than let the
  // values of named secrets go out as they are (engram#677). Another
  // user's too (engram#695): it used to stop the daemon, and capture with
  // it. Not read at all while ENGRAM_VAULT_KEY is set.
  { name: "vault-key", holds: { mode: R_OK, unlessEnv: "ENGRAM_VAULT_KEY" }, warns: W_OK },
  // The daemon's output. One that can't be written only costs the log: the
  // daemon runs without it (engram#679). It used to stop every start
  // through `engram start`, launchd and the systemd unit.
  { name: "daemon.log", warns: W_OK },
  // The daemon replaces these, and the CLI reads them.
  { name: "status.json", warns: R_OK | W_OK },
  { name: "daemon.pid", warns: R_OK | W_OK },
  // Another user's socket is never taken for the daemon's, whatever its
  // mode (engram#612), so the daemon couldn't hold the single-daemon lock.
  // It would run beside the daemon that made the socket, if that one still
  // runs, and everything would be captured twice.
  { name: "daemon.sock", stops: { mode: "always" } },
];

export interface OwnershipCheck {
  platform?: NodeJS.Platform;
  /** The effective uid: null where there is none (Windows). */
  euid?: number | null;
  env?: NodeJS.ProcessEnv;
  /** ~/.engram */
  dir?: string;
  /** Who owns `path`, through a symlink: null when nothing is there, or it can't be looked at. */
  ownerOf?: (path: string) => number | null;
  /** Whether this process has `mode` (R_OK, W_OK, X_OK) on `path`. */
  canAccess?: (path: string, mode: number) => boolean;
  /** The permission bits of `path`, through a symlink: null when nothing is there, or it can't be looked at. */
  modeOf?: (path: string) => number | null;
}

export interface ForeignFiles {
  /** ~/.engram itself is another user's, and nothing can be made in it. */
  dir: boolean;
  /** The files in it that are another user's and get in the way, by name. */
  files: string[];
  /** Root owns every one of them: `sudo engram …`, as a rule. */
  root: boolean;
  /** The daemon can't run until they are the user's. */
  stopsDaemon: boolean;
  /**
   * The daemon runs, but sends nothing until they are the user's: it can't
   * read the vault key, so what it captures waits here (engram#695).
   */
  holdsSends: boolean;
}

function owner(path: string): number | null {
  try {
    // BigInt fields: daemon.sock is one of these, and a plain stat of a
    // socket throws off how Node loads modules after it (see
    // lstatSocketPath in instance.ts).
    return Number(statSync(path, { bigint: true }).uid);
  } catch {
    return null;
  }
}

function access(path: string, mode: number): boolean {
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

function permissions(path: string): number | null {
  try {
    return Number(statSync(path, { bigint: true }).mode) & 0o777;
  } catch {
    return null;
  }
}

/**
 * What in ~/.engram is another user's and gets in Engram's way, or null
 * when nothing is (or ~/.engram isn't there yet). Goes by access as well as
 * by owner, so a file that only looks like another user's, as on a network
 * home that maps owners wrongly, isn't counted while Engram can use it.
 *
 * Never on Windows, and never as root: root can use any file, and is
 * refused before this where it would matter (engram#653).
 */
export function foreignFiles({
  platform = process.platform,
  euid = process.geteuid?.() ?? null,
  env = process.env,
  dir = join(homedir(), ".engram"),
  ownerOf = owner,
  canAccess = access,
}: OwnershipCheck = {}): ForeignFiles | null {
  if (platform === "win32" || euid === null || euid === 0) return null;
  const dirOwner = ownerOf(dir);
  if (dirOwner === null) return null;
  const found: ForeignFiles = {
    dir: false,
    files: [],
    root: true,
    stopsDaemon: false,
    holdsSends: false,
  };
  const counted = (uid: number): void => {
    if (uid !== 0) found.root = false;
  };
  // The daemon makes its socket, and SQLite its -wal and -shm, in it.
  if (dirOwner !== euid && !canAccess(dir, R_OK | W_OK | X_OK)) {
    found.dir = true;
    found.stopsDaemon = true;
    counted(dirOwner);
  }
  for (const { name, stops, holds, warns } of WATCHED) {
    const path = join(dir, name);
    const uid = ownerOf(path);
    if (uid === null || uid === euid) continue;
    const stopped =
      stops !== undefined &&
      !(stops.unlessEnv && env[stops.unlessEnv]) &&
      (stops.mode === "always" || !canAccess(path, stops.mode));
    const held = holds !== undefined && !(holds.unlessEnv && env[holds.unlessEnv]) && !canAccess(path, holds.mode);
    const warned = warns !== undefined && !canAccess(path, warns);
    if (!stopped && !held && !warned) continue;
    found.files.push(name);
    counted(uid);
    if (stopped) found.stopsDaemon = true;
    if (held) found.holdsSends = true;
  }
  return found.dir || found.files.length > 0 ? found : null;
}

/** "a", "a and b", "a, b and c", "a, b, c and 2 more" */
function names(list: string[]): string {
  const shown = list.length > 4 ? [...list.slice(0, 3), `${list.length - 3} more`] : list;
  return shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

/** Whether to say "it" or "them" of what `f` found. */
export function foreignAreMany(f: ForeignFiles): boolean {
  return !f.dir && f.files.length > 1;
}

/**
 * What is whose, and what that stops. "daemon.db and config.json in
 * ~/.engram belong to root, not to you, so the daemon can't start, and
 * nothing new is captured." `daemon`: whether the daemon runs now, where
 * that is known. One that runs was started before them, and captures until
 * it stops. What stops the daemon is said rather than what holds its sends:
 * a daemon that doesn't run sends nothing either.
 */
export function foreignFilesProblem(f: ForeignFiles, daemon?: "running" | "stopped"): string {
  const many = foreignAreMany(f);
  const what = f.dir ? "~/.engram" : `${names(f.files)} in ~/.engram`;
  const whose = `${what} ${many ? "belong" : "belongs"} to ${f.root ? "root" : "another user"}, not to you`;
  if (!f.stopsDaemon) {
    if (f.holdsSends) return `${whose}. Until ${many ? "they are" : "it is"} yours, captured messages wait on this machine: nothing is lost.`;
    if (!f.dir && f.files.length === 1 && f.files[0] === "daemon.log") return `${whose}, so the daemon can't write its log.`;
    return `${whose}, so Engram can't update ${many ? "them" : "it"}.`;
  }
  if (daemon === "running") return `${whose}, so the daemon can't start again once it stops.`;
  if (daemon === "stopped") return `${whose}, so the daemon can't start, and nothing new is captured.`;
  return `${whose}, so the daemon can't start.`;
}

/** "Make it yours with: sudo chown …". `then`: "Then make it yours …", after another step. */
export function foreignFilesFix(f: ForeignFiles, then = false): string {
  return `${then ? "Then make" : "Make"} ${foreignAreMany(f) ? "them" : "it"} yours with: ${OWNERSHIP_FIX}`;
}

/**
 * ~/.engram is the user's, and its own permissions keep them out of it
 * (engram#723), as `chmod -R 600 ~/.engram` leaves it: every file in it is
 * still theirs and whole.
 */
export interface LockedDir {
  /** It can't be searched (no x): nothing in it can be opened, or even looked at. */
  search: boolean;
  /** Nothing can be made in it (no w): no socket, PID file, -wal or -shm, and no file replaced. */
  write: boolean;
  /** The command that gives the user back what is missing: "chmod u+x ~/.engram". */
  command: string;
}

/**
 * Whether ~/.engram is the user's and its permissions keep them out of it,
 * or null when they don't (or ~/.engram isn't there yet, or is another
 * user's: foreignFiles). A folder that can't be searched hides every file
 * in it, so what fails is each file the CLI and the daemon open, and what
 * they said was about the file: "config.json can't be read", "Fix the
 * file", a chmod of the file, which can't reach it either.
 *
 * Only what the owner's own bits keep from them counts, so the command
 * that is given, a chmod of their own folder, is sure to fix it. An ACL or
 * a read-only disk is something else, and chmod wouldn't help. A folder
 * that only can't be listed (no r) isn't counted: nothing in Engram needs
 * that but the daemon's tidy-up at start, which goes without it. The
 * command adds r back with the rest, though.
 *
 * Never on Windows, and never as root: root can open anything.
 */
export function lockedDir({
  platform = process.platform,
  euid = process.geteuid?.() ?? null,
  dir = join(homedir(), ".engram"),
  ownerOf = owner,
  canAccess = access,
  modeOf = permissions,
}: OwnershipCheck = {}): LockedDir | null {
  if (platform === "win32" || euid === null || euid === 0) return null;
  if (ownerOf(dir) !== euid) return null;
  const mode = modeOf(dir);
  if (mode === null) return null;
  const search = (mode & 0o100) === 0 && !canAccess(dir, X_OK);
  const write = (mode & 0o200) === 0 && !canAccess(dir, W_OK);
  if (!search && !write) return null;
  const missing = (
    [
      [0o400, "r"],
      [0o200, "w"],
      [0o100, "x"],
    ] as const
  )
    .filter(([bit]) => (mode & bit) === 0)
    .map(([, letter]) => letter)
    .join("");
  return { search, write, command: `chmod u+${missing} ~/.engram` };
}

/**
 * Why `doing` failed, in a ~/.engram that can't be searched (search):
 * "~/.engram's permissions keep you from opening config.json in it". Said
 * instead of what is wrong with the file, which nothing is.
 */
export function lockedDirReason(doing: string): string {
  return `~/.engram's permissions keep you from ${doing} in it`;
}

/**
 * What ~/.engram's permissions keep the user from, and what that stops.
 * "~/.engram is yours, but its permissions keep you from opening the files
 * in it, so the daemon can't start, and nothing new is captured."
 * `daemon`: whether the daemon runs now, where that is known. One that
 * runs was started before, and has what it opened then; one that can't
 * open the files in it any more can't read config.json either, so it holds
 * what it would capture until it can (engram#673), and then goes on from
 * where it stopped.
 */
export function lockedDirProblem(l: LockedDir, daemon?: "running" | "stopped"): string {
  const kept = `~/.engram is yours, but its permissions keep you from ${l.search ? "opening the files in it" : "making files in it"}`;
  if (daemon === "running") {
    return l.search
      ? `${kept}, so capture is paused, and the daemon can't start again once it stops.`
      : `${kept}, so the daemon can't start again once it stops.`;
  }
  if (daemon === "stopped") return `${kept}, so the daemon can't start, and nothing new is captured.`;
  return `${kept}, so the daemon can't start.`;
}

/** "To fix it, run: chmod u+x ~/.engram" */
export function lockedDirFix(l: LockedDir): string {
  return `To fix it, run: ${l.command}`;
}
