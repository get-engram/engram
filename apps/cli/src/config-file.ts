/**
 * Reading ~/.engram/config.json without trusting it (engram#673). Shared by
 * the CLI and the daemon, and free of the file's location: callers pass the
 * path, or read the text themselves. vault-key.ts reads ~/.engram/vault-key
 * the same way (engram#677).
 *
 * IMPORTANT: Node built-ins only. The daemon's exclusions use this module.
 */

import { lstatSync, readFileSync } from "node:fs";

/**
 * config.json is there, but Engram can't use it: it can't be read, or what
 * it holds isn't settings. It holds the API key and the folders excluded
 * from capture, so this fails closed. The daemon holds new messages rather
 * than capture from a folder it can't tell is excluded, and a command that
 * saves the file stops rather than replace what is in it.
 *
 * The message names the problem and never quotes the file: JSON.parse's
 * own messages quote the text around the error, which can be part of the
 * key, and these messages reach daemon.log, status.json and notifications.
 */
export class ConfigUnreadable extends Error {
  /** What is wrong, worded to follow "config.json", e.g. "isn't valid JSON". */
  readonly problem: string;
  /**
   * The file is empty. The daemon holds as for any other problem, since a
   * file being written in place is empty for a moment; a command that
   * saves the file may write it, since there is nothing in it to lose.
   */
  readonly empty: boolean;

  constructor(problem: string, options: { empty?: boolean } = {}) {
    super(`~/.engram/config.json ${problem}`);
    this.name = "ConfigUnreadable";
    this.problem = problem;
    this.empty = options.empty ?? false;
  }
}

/** What a read that failed says is wrong: from its error code, not its message. */
function codeProblem(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === "EACCES" || code === "EPERM") return "can't be read: permission denied";
  if (code === "EISDIR") return "is a folder, not a file";
  if (typeof code === "string" && /^[A-Z0-9_]+$/.test(code)) return `can't be read (${code})`;
  return "can't be read";
}

/** The ConfigUnreadable for a read that failed: from its error code, not its message. */
export function unreadable(err: unknown): ConfigUnreadable {
  return new ConfigUnreadable(codeProblem(err));
}

/**
 * True when a read of `file` failed because there is no config.json, which
 * means no settings, not damaged ones. A link to a file that isn't there
 * is not missing: the settings are somewhere that can't be reached right
 * now, a volume that isn't mounted, say.
 */
export function isMissing(err: unknown, file: string): boolean {
  if ((err as NodeJS.ErrnoException | null)?.code !== "ENOENT") return false;
  try {
    lstatSync(file);
  } catch {
    return true;
  }
  return false;
}

/**
 * What is wrong with a file a read of it failed on, given it isn't missing
 * (isMissing): ENOENT then means a link to nothing. Worded to follow the
 * file's name, and from the error's code, never its message.
 */
export function readProblem(err: unknown): string {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT"
    ? "is a link to a file that isn't there"
    : codeProblem(err);
}

/**
 * The ConfigUnreadable for a read of config.json that failed, given the
 * file isn't missing (isMissing).
 */
export function readFailure(err: unknown): ConfigUnreadable {
  return new ConfigUnreadable(readProblem(err));
}

/**
 * What is wrong with a file a write of it failed on (engram#681), worded
 * to follow the file's name: from the error's code, never its message.
 */
export function writeProblem(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === "EACCES" || code === "EPERM") return "can't be written: permission denied";
  if (code === "EROFS") return "can't be written: the disk it's on is read-only";
  if (code === "ENOSPC") return "can't be written: the disk it's on is full";
  if (code === "EDQUOT") return "can't be written: the disk quota is used up";
  if (typeof code === "string" && /^[A-Z0-9_]+$/.test(code)) return `can't be written (${code})`;
  return "can't be written";
}

/**
 * config.json's text as settings: a JSON object. Throws ConfigUnreadable
 * for anything else. A leading byte-order mark, which some Windows editors
 * add, is skipped.
 */
export function parseConfigText(text: string): Record<string, unknown> {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (body.trim() === "") throw new ConfigUnreadable("is empty", { empty: true });
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ConfigUnreadable("isn't valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigUnreadable("isn't a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** The settings in `file`, or null when there is no such file. Throws ConfigUnreadable. */
export function readConfigFileSync(file: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch (err: unknown) {
    if (isMissing(err, file)) return null;
    throw readFailure(err);
  }
  return parseConfigText(text);
}

/**
 * The excluded folders in `config`, as saved: none when it has no
 * excludePaths. Throws ConfigUnreadable when excludePaths is anything but
 * a list of paths, since then which folders are excluded can't be told.
 */
export function excludePathsOf(config: { excludePaths?: unknown }): string[] {
  const paths = config.excludePaths;
  if (paths === undefined || paths === null) return [];
  if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string")) {
    throw new ConfigUnreadable("has an excludePaths that isn't a list of paths");
  }
  return paths as string[];
}
