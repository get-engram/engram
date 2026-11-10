import { realpathSync } from "node:fs";

/**
 * A file in a Homebrew keg by the name that outlasts the keg (engram#652):
 * `<prefix>/Cellar/<formula>/<version>/…` through `<prefix>/opt/<formula>/…`,
 * the link Homebrew points at each new version of the formula. Any other
 * path is returned as it is.
 *
 * Start at login names Node and the worker by their real paths, because a
 * version manager's links may not outlast the shell that made them (fnm's
 * multishell directories). But Homebrew's Node reports its versioned keg as
 * process.execPath, a CLI installed with brew runs from one, and `brew
 * upgrade` removes the old version: from the next login, launchd or systemd
 * would start a program that is gone.
 *
 * Only when the link leads to this very file: a version that is installed
 * but not the formula's current one, or a Cellar with no opt beside it,
 * keeps its own path. The opt link is Homebrew's, as the Cellar is, so it
 * hands the job to no one who couldn't change the program already.
 */
export function throughOptLink(path: string): string {
  // The last Cellar in the path: the prefix can be anywhere, and what follows
  // a keg is Node's own layout or the CLI's.
  const keg = /^(.+)\/Cellar\/([^/]+)\/[^/]+\/(.+)$/.exec(path);
  if (keg === null) return path;
  const [, prefix, formula, rest] = keg;
  const opt = `${prefix}/opt/${formula}/${rest}`;
  try {
    return realpathSync.native(opt) === path ? opt : path;
  } catch {
    return path; // no opt link, or nothing there
  }
}

/**
 * The path is in the current version of a Homebrew keg, which has a lasting
 * name: a plist or unit naming one is from before engram#652 and is
 * rewritten.
 */
export function pinnedToKeg(path: string): boolean {
  return throughOptLink(path) !== path;
}
