/**
 * A CLI that a package runner runs (engram#665): `npx @getengram/cli`,
 * `pnpm dlx`, `bunx`. Each installs the package into a cache or a temporary
 * folder and runs it from there, and none promises the folder stays:
 * clearing npm's cache is the usual cure for a stale npx, pnpm makes a new
 * dlx folder after a day, and a temporary folder goes when the system
 * clears it. Start at login written from such a run named the worker in
 * that folder, and once the folder was gone the daemon no longer started at
 * login, without a word.
 *
 * Told by the path the CLI runs from, which is the path start at login
 * would name, and not by the environment: npm sets npm_command=exec for a
 * project's own node_modules/.bin too, and an installed CLI that a script
 * run through npx starts inherits it.
 */

/** Where a package runner installs a package to run it, and how a message names it. */
const RUNNER_CACHES: readonly { pattern: RegExp; where: string }[] = [
  // npm 7 and later: <npm cache>/_npx/<hash>/node_modules/…; npm 6:
  // _npx/<pid>/lib/node_modules/….
  { pattern: /[\\/]_npx[\\/][^\\/]+[\\/](?:lib[\\/])?node_modules[\\/]/, where: "npx's cache" },
  // pnpm 9 and later: <pnpm cache>/dlx/<key>/<time>-<pid>/node_modules/…,
  // which <key>/pkg links to.
  {
    pattern: /[\\/]dlx[\\/][0-9a-z]+[\\/](?:[0-9a-f]+-[0-9a-f]+|pkg)[\\/]node_modules[\\/]/,
    where: "pnpm's dlx cache",
  },
  // bunx: <bun's cache or temporary folder>/.bunx-<uid>/<package>/…, or
  // bunx-<uid>-<package>/… in the temporary folder.
  {
    pattern: /[\\/](?:\.bunx-\d+|bunx-\d+-[^\\/]+)[\\/](?:[^\\/]+[\\/])*node_modules[\\/]/,
    where: "bunx's cache",
  },
  // pnpm 8 (<store>/v3/tmp/dlx-<pid>) and yarn dlx (<tmp>/xfs-<hex>/dlx-<pid>),
  // removed as the command ends.
  {
    pattern: /[\\/](?:tmp|xfs-[0-9a-f]+)[\\/]dlx-\d+[\\/](?:[^\\/]+[\\/])*node_modules[\\/]/,
    where: "a temporary folder",
  },
];

/**
 * Where `path` is, as a message names it ("npx's cache"), when a package
 * runner installed it there; null for any other path. POSIX and Windows
 * paths alike.
 */
export function runnerCacheOf(path: string): string | null {
  for (const { pattern, where } of RUNNER_CACHES) {
    if (pattern.test(path)) return where;
  }
  return null;
}

/** How to install the CLI, so that start at login names files that stay. */
export const INSTALL_CLI = "npm install -g @getengram/cli";
