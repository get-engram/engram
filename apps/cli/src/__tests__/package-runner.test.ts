import { describe, it, expect } from "vitest";
import { runnerCacheOf } from "../daemon/package-runner.js";

/**
 * engram#665 — a CLI that npx, pnpm dlx or bunx runs is installed in a cache
 * or a temporary folder that can be cleared at any time, and start at login
 * mustn't name it. Paths as each runner lays them out, POSIX and Windows
 * alike; the npx and pnpm ones as npm 10, pnpm 9 and pnpm 10 made them.
 */

const CLI = "@getengram/cli/dist/daemon/worker.js";
const WIN_CLI = "@getengram\\cli\\dist\\daemon\\login-start.js";
const PNPM_CLI = `.pnpm/@getengram+cli@0.6.1/node_modules/${CLI}`;

describe("runnerCacheOf", () => {
  it.each([
    // npm 7 and later
    [`/Users/ana/.npm/_npx/f3920abdac2db749/node_modules/${CLI}`, "npx's cache"],
    [`/home/ana/.npm/_npx/f3920abdac2db749/node_modules/${CLI}`, "npx's cache"],
    [`/srv/cache/npm/_npx/f3920abdac2db749/node_modules/${CLI}`, "npx's cache"],
    [`C:\\Users\\Ana\\AppData\\Local\\npm-cache\\_npx\\f3920abdac2db749\\node_modules\\${WIN_CLI}`, "npx's cache"],
    // npm 6
    [`/home/ana/.npm/_npx/48213/lib/node_modules/${CLI}`, "npx's cache"],
    [`C:\\Users\\Ana\\AppData\\Roaming\\npm-cache\\_npx\\48213\\node_modules\\${WIN_CLI}`, "npx's cache"],
    // pnpm 9: a base32 key; pnpm 10: a hex one. Through the pkg link too.
    [
      `/Users/ana/Library/Caches/pnpm/dlx/rahzp5knphcevmme35czyqjkz4/1a1c976a103-2f63/node_modules/${PNPM_CLI}`,
      "pnpm's dlx cache",
    ],
    [
      `/home/ana/.cache/pnpm/dlx/51c7cc95c0586d70fc8f8c7acc82072a904d4cb0c1f1293d1f72d7b99e6d1b42/1a1c976fb69-3064/node_modules/${PNPM_CLI}`,
      "pnpm's dlx cache",
    ],
    [`/home/ana/.cache/pnpm/dlx/rahzp5knphcevmme35czyqjkz4/pkg/node_modules/${PNPM_CLI}`, "pnpm's dlx cache"],
    [
      `C:\\Users\\Ana\\AppData\\Local\\pnpm-cache\\dlx\\rahzp5knphcevmme35czyqjkz4\\1a1c976a103-2f63\\node_modules\\.pnpm\\@getengram+cli@0.6.1\\node_modules\\${WIN_CLI}`,
      "pnpm's dlx cache",
    ],
    // bunx, in bun's cache and in the temporary folder, a scoped package two folders deep
    [`/Users/ana/.bun/install/cache/.bunx-501/@getengram/cli@latest/node_modules/${CLI}`, "bunx's cache"],
    [`/private/var/folders/x1/abc/T/bunx-501-@getengram/cli@latest/node_modules/${CLI}`, "bunx's cache"],
    [`C:\\Users\\Ana\\AppData\\Local\\Temp\\bunx-3021547710-@getengram\\cli@latest\\node_modules\\${WIN_CLI}`, "bunx's cache"],
    // pnpm 8 and yarn dlx, removed as the command ends
    [`/Users/ana/Library/pnpm/store/v3/tmp/dlx-48213/node_modules/${PNPM_CLI}`, "a temporary folder"],
    [`/private/var/folders/x1/abc/T/xfs-1a2b3c4d/dlx-48213/node_modules/${CLI}`, "a temporary folder"],
    [
      `/tmp/xfs-1a2b3c4d/dlx-48213/.yarn/unplugged/@getengram-cli-npm-0.6.1-0123abcd/node_modules/${CLI}`,
      "a temporary folder",
    ],
    // Forward slashes on Windows
    [`C:/Users/Ana/AppData/Local/npm-cache/_npx/f3920abdac2db749/node_modules/${CLI}`, "npx's cache"],
  ])("%s is in %s", (path, where) => {
    expect(runnerCacheOf(path)).toBe(where);
  });

  it.each([
    // Installed with npm, under a Node of a version manager's or the system's
    `/Users/ana/.local/share/fnm/node-versions/v20.20.2/installation/lib/node_modules/${CLI}`,
    `/Users/ana/.nvm/versions/node/v22.11.0/lib/node_modules/${CLI}`,
    `/usr/local/lib/node_modules/${CLI}`,
    `/usr/lib/node_modules/${CLI}`,
    `C:\\Users\\Ana\\AppData\\Roaming\\npm\\node_modules\\${WIN_CLI}`,
    `C:\\Program Files\\nodejs\\node_modules\\${WIN_CLI}`,
    // Homebrew
    `/opt/homebrew/lib/node_modules/${CLI}`,
    `/opt/homebrew/Cellar/engram/0.7.0/libexec/lib/node_modules/${CLI}`,
    `/opt/homebrew/opt/engram/libexec/lib/node_modules/${CLI}`,
    // pnpm and bun globals
    `/Users/ana/Library/pnpm/global/5/node_modules/${PNPM_CLI}`,
    `/home/ana/.local/share/pnpm/global/5/node_modules/${PNPM_CLI}`,
    `/Users/ana/.bun/install/global/node_modules/${CLI}`,
    // A project's own, and a source checkout
    `/Users/ana/work/app/node_modules/${CLI}`,
    "/Users/ana/code/engram/apps/cli/dist/daemon/worker.js",
    // Folders named like a runner's
    `/Users/ana/_npxx/f3920abdac2db749/node_modules/${CLI}`,
    `/Users/ana/my_npx/f3920abdac2db749/node_modules/${CLI}`,
    `/Users/ana/projects/dlx/app/node_modules/${CLI}`,
    `/Users/ana/dlx/tools/build-2/node_modules/${CLI}`,
    // …with a folder after dlx that no pnpm key looks like
    `/Users/ana/dlx/My-App/pkg/node_modules/${CLI}`,
    `/Users/ana/projects/dlx/web.app/1a-2b/node_modules/${CLI}`,
    `/Users/ana/dlx-tools/app/node_modules/${CLI}`,
    `/Users/ana/projects/dlx-2024/node_modules/${CLI}`,
    `/Users/ana/bunx-notes/app/node_modules/${CLI}`,
    `/Users/ana/.bunx/app/node_modules/${CLI}`,
    // In a runner's folder, but not in what it installed
    "/Users/ana/.npm/_npx/f3920abdac2db749/package.json",
    "/Users/ana/Library/Caches/pnpm/dlx/rahzp5knphcevmme35czyqjkz4/1a1c976a103-2f63/package.json",
  ])("%s isn't in a runner's cache", (path) => {
    expect(runnerCacheOf(path)).toBeNull();
  });
});
