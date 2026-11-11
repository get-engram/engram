import { loginStartPath, workerPath } from "./launch.js";

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
 *
 * Run that way, the CLI isn't on PATH, so what it says names its commands
 * as it was run (engram#727): `npx @getengram/cli stop`, not `engram stop`,
 * which the shell can't find. Each runner runs the package's only bin.
 */

/**
 * Where a package runner installs a package to run it, how a message names
 * that, and the command that runs the CLI through the runner.
 */
const RUNNER_CACHES: readonly { pattern: RegExp; where: string; runs: string }[] = [
  // npm 7 and later: <npm cache>/_npx/<hash>/node_modules/…; npm 6:
  // _npx/<pid>/lib/node_modules/….
  {
    pattern: /[\\/]_npx[\\/][^\\/]+[\\/](?:lib[\\/])?node_modules[\\/]/,
    where: "npx's cache",
    runs: "npx @getengram/cli",
  },
  // pnpm 9 and later: <pnpm cache>/dlx/<key>/<time>-<pid>/node_modules/…,
  // which <key>/pkg links to.
  {
    pattern: /[\\/]dlx[\\/][0-9a-z]+[\\/](?:[0-9a-f]+-[0-9a-f]+|pkg)[\\/]node_modules[\\/]/,
    where: "pnpm's dlx cache",
    runs: "pnpm dlx @getengram/cli",
  },
  // bunx: <bun's cache or temporary folder>/.bunx-<uid>/<package>/…, or
  // bunx-<uid>-<package>/… in the temporary folder.
  {
    pattern: /[\\/](?:\.bunx-\d+|bunx-\d+-[^\\/]+)[\\/](?:[^\\/]+[\\/])*node_modules[\\/]/,
    where: "bunx's cache",
    runs: "bunx @getengram/cli",
  },
  // pnpm 8: <store>/v3/tmp/dlx-<pid>, removed as the command ends.
  {
    pattern: /[\\/]tmp[\\/]dlx-\d+[\\/](?:[^\\/]+[\\/])*node_modules[\\/]/,
    where: "a temporary folder",
    runs: "pnpm dlx @getengram/cli",
  },
  // yarn dlx: <tmp>/xfs-<hex>/dlx-<pid>, removed as the command ends.
  {
    pattern: /[\\/]xfs-[0-9a-f]+[\\/]dlx-\d+[\\/](?:[^\\/]+[\\/])*node_modules[\\/]/,
    where: "a temporary folder",
    runs: "yarn dlx @getengram/cli",
  },
];

function runnerOf(path: string): (typeof RUNNER_CACHES)[number] | null {
  return RUNNER_CACHES.find(({ pattern }) => pattern.test(path)) ?? null;
}

/**
 * Where `path` is, as a message names it ("npx's cache"), when a package
 * runner installed it there; null for any other path. POSIX and Windows
 * paths alike.
 */
export function runnerCacheOf(path: string): string | null {
  return runnerOf(path)?.where ?? null;
}

/**
 * The command that runs the CLI at `path` through the package runner that
 * installed it there ("npx @getengram/cli"); null for any other path.
 */
export function runnerCommandOf(path: string): string | null {
  return runnerOf(path)?.runs ?? null;
}

/** How to install the CLI, so that start at login names files that stay. */
export const INSTALL_CLI = "npm install -g @getengram/cli";

/**
 * The path start at login would name for this CLI: the worker, and on
 * Windows the sign-in entry beside it. Where it is tells how the CLI runs.
 */
function thisCliPath(): string {
  return process.platform === "win32" ? loginStartPath() : workerPath();
}

/**
 * Where this CLI runs from, as a message names it ("npx's cache"), when a
 * package runner installed it there (engram#665); null when it is
 * installed.
 */
export function runnerCacheOfThisCli(): string | null {
  return runnerCacheOf(thisCliPath());
}

/** Commands that turn on start at login, which a runner's run refuses (engram#665). */
const STARTS_AT_LOGIN = /^(?:install|start --install)$/;

/**
 * `engram <rest>` as the user can run it from here (engram#727): through
 * the package runner this CLI runs from (`npx @getengram/cli stop`), or
 * `engram stop` when it is installed. Start at login (`install`, `start
 * --install`) needs the CLI installed, so from a runner that comes first.
 * With no `rest`, the command alone.
 */
export function engramCommand(rest = ""): string {
  const runs = runnerCommandOf(thisCliPath());
  const command = rest === "" ? "engram" : `engram ${rest}`;
  if (runs === null) return command;
  if (STARTS_AT_LOGIN.test(rest)) return `${INSTALL_CLI} && ${command}`;
  return rest === "" ? runs : `${runs} ${rest}`;
}
