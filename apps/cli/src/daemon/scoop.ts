import { realpathSync } from "node:fs";

/**
 * Node from Scoop by the name that outlasts its version (engram#664):
 * `<root>\apps\<app>\<version>\node.exe` through
 * `<root>\apps\<app>\current\node.exe`, the junction `scoop update` moves to
 * each new version of the app. Any other path is returned as it is.
 *
 * The Windows sign-in entry names Node by its real path, through any links
 * (nodePathForEntry), and on Windows that resolves Scoop's junction too. So
 * the entry named a version that `scoop cleanup` removes after the next
 * update: from the next sign-in, Windows ran a program that was gone.
 *
 * Only a file at the top of a version, where Scoop's Node apps (nodejs,
 * nodejs-lts) keep node.exe: a file deeper in can be one the app left there
 * that the next version doesn't have. And only when `current` leads to this
 * very file: a version that is installed but isn't the app's current one,
 * or an app with no `current` (Scoop's no_junction setting), keeps its own
 * path. `current` is Scoop's, as the version is, so it hands the program to
 * no one who couldn't change it already.
 *
 * The CLI needs nothing of the kind: Scoop's Node apps keep npm's global
 * packages in their persist folder, which every version shares. A new
 * version can be a new major of Node, for which the worker rebuilds
 * better-sqlite3 before loading it (preflight.ts); the sign-in entry and the
 * supervisor use only Node's built-ins.
 *
 * nvm-windows's link isn't followed: `nvm use` moves it to whichever version
 * the user works with, and each version has its own global packages, this
 * CLI among them. Its entry keeps the version it was written with.
 *
 * Either separator: Windows takes both, and the tests run this on every OS.
 */
export function throughScoopCurrent(path: string): string {
  const v = inVersion(path);
  if (v === null || isCurrent(v.version)) return path;
  const current = `${v.app}${v.sep}current${v.sep}${v.file}`;
  try {
    return realpathSync.native(current) === path ? current : path;
  } catch {
    return path; // no current, or nothing there
  }
}

/**
 * `entry` names the program `ours` names by a Scoop app's `current`
 * (throughScoopCurrent), by a version of that same app instead: the version
 * `current` leads to now, or one it led to before the last update. The next
 * update and `scoop cleanup` remove either, and `current` outlasts them. A
 * sign-in entry from before engram#664 names one, or one a CLI wrote that
 * ran on a version that wasn't current; this CLI's entry, which names
 * `ours`, replaces it.
 *
 * Never of `ours` itself, so a CLI never rewrites the entry it just wrote.
 * And never when `ours` isn't by a `current`: a CLI run on a version that
 * isn't current, or on a Node that isn't Scoop's, would trade an entry that
 * works for one no more lasting, so the entry stays until it breaks and is
 * repaired then.
 *
 * The paths alone, looked up nowhere. Windows paths, the same whatever
 * their case or separators.
 */
export function scoopVersionOf(entry: string, ours: string): boolean {
  const o = inVersion(ours);
  const e = inVersion(entry);
  return (
    o !== null &&
    e !== null &&
    isCurrent(o.version) &&
    !isCurrent(e.version) &&
    samePath(o.app, e.app) &&
    samePath(o.file, e.file)
  );
}

/** A file at the top of a version of a Scoop app: <root>\apps\<app>\<version>\<file>. */
function inVersion(path: string): { app: string; sep: string; version: string; file: string } | null {
  const m = /^(.*[\\/]apps[\\/][^\\/]+)([\\/])([^\\/]+)[\\/]([^\\/]+)$/i.exec(path);
  return m === null ? null : { app: m[1], sep: m[2], version: m[3], file: m[4] };
}

function isCurrent(version: string): boolean {
  return version.toLowerCase() === "current";
}

function samePath(a: string, b: string): boolean {
  return a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();
}
