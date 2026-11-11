import { afterEach, describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { engramCommand, runnerCacheOf, runnerCommandOf } from "../daemon/package-runner.js";

// Where this CLI's worker and Windows sign-in entry are, for engramCommand.
const cli = vi.hoisted(() => ({ worker: "", loginStart: "" }));
vi.mock("../daemon/launch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/launch.js")>()),
  workerPath: () => cli.worker,
  loginStartPath: () => cli.loginStart,
}));

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

// engram#727 — run through a package runner, the CLI isn't on PATH, so what
// it says names its commands as it was run.
const NPX = `/Users/ana/.npm/_npx/f3920abdac2db749/node_modules/${CLI}`;
const PNPM = `/Users/ana/Library/Caches/pnpm/dlx/rahzp5knphcevmme35czyqjkz4/1a1c976a103-2f63/node_modules/${PNPM_CLI}`;
const BUNX = `/Users/ana/.bun/install/cache/.bunx-501/@getengram/cli@latest/node_modules/${CLI}`;
const YARN = `/private/var/folders/x1/abc/T/xfs-1a2b3c4d/dlx-48213/node_modules/${CLI}`;
const INSTALLED = `/usr/local/lib/node_modules/${CLI}`;

describe("runnerCommandOf", () => {
  it.each([
    [NPX, "npx @getengram/cli"],
    [`/home/ana/.npm/_npx/48213/lib/node_modules/${CLI}`, "npx @getengram/cli"],
    [`C:\\Users\\Ana\\AppData\\Local\\npm-cache\\_npx\\f3920abdac2db749\\node_modules\\${WIN_CLI}`, "npx @getengram/cli"],
    [PNPM, "pnpm dlx @getengram/cli"],
    [`/home/ana/.cache/pnpm/dlx/rahzp5knphcevmme35czyqjkz4/pkg/node_modules/${PNPM_CLI}`, "pnpm dlx @getengram/cli"],
    // pnpm 8's temporary folder, and yarn's, which both read as "a temporary folder"
    [`/Users/ana/Library/pnpm/store/v3/tmp/dlx-48213/node_modules/${PNPM_CLI}`, "pnpm dlx @getengram/cli"],
    [YARN, "yarn dlx @getengram/cli"],
    [
      `/tmp/xfs-1a2b3c4d/dlx-48213/.yarn/unplugged/@getengram-cli-npm-0.6.1-0123abcd/node_modules/${CLI}`,
      "yarn dlx @getengram/cli",
    ],
    [BUNX, "bunx @getengram/cli"],
    [`C:\\Users\\Ana\\AppData\\Local\\Temp\\bunx-3021547710-@getengram\\cli@latest\\node_modules\\${WIN_CLI}`, "bunx @getengram/cli"],
  ])("%s runs as %s", (path, runs) => {
    expect(runnerCommandOf(path)).toBe(runs);
  });

  it.each([
    INSTALLED,
    `/opt/homebrew/opt/engram/libexec/lib/node_modules/${CLI}`,
    `C:\\Users\\Ana\\AppData\\Roaming\\npm\\node_modules\\${WIN_CLI}`,
    "/Users/ana/code/engram/apps/cli/dist/daemon/worker.js",
  ])("%s runs as installed", (path) => {
    expect(runnerCommandOf(path)).toBeNull();
  });
});

describe("engramCommand", () => {
  const HOST = process.platform;
  const runFrom = (path: string): void => {
    cli.worker = path;
    cli.loginStart = path;
  };
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: HOST, configurable: true });
    runFrom("");
  });

  it("names engram's commands as they are when it is installed", () => {
    runFrom(INSTALLED);
    expect(engramCommand("stop")).toBe("engram stop");
    expect(engramCommand("auth login <key>")).toBe("engram auth login <key>");
    expect(engramCommand("install")).toBe("engram install");
    expect(engramCommand("start --install")).toBe("engram start --install");
    expect(engramCommand()).toBe("engram");
  });

  it.each([
    [NPX, "npx @getengram/cli"],
    [PNPM, "pnpm dlx @getengram/cli"],
    [BUNX, "bunx @getengram/cli"],
    [YARN, "yarn dlx @getengram/cli"],
  ])("run from %s, names them through %s", (path, runs) => {
    runFrom(path);
    expect(engramCommand("stop")).toBe(`${runs} stop`);
    expect(engramCommand("vault set <NAME>")).toBe(`${runs} vault set <NAME>`);
    expect(engramCommand("uninstall")).toBe(`${runs} uninstall`);
    expect(engramCommand("start")).toBe(`${runs} start`);
    expect(engramCommand()).toBe(runs);
  });

  it("from a runner, has start at login installed first, which the runner's copy can't have (engram#665)", () => {
    runFrom(NPX);
    expect(engramCommand("install")).toBe("npm install -g @getengram/cli && engram install");
    expect(engramCommand("start --install")).toBe("npm install -g @getengram/cli && engram start --install");
  });

  it("tells by the worker's path, and on Windows by the sign-in entry's", () => {
    cli.worker = INSTALLED;
    cli.loginStart = NPX;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    expect(engramCommand("stop")).toBe("engram stop");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    expect(engramCommand("stop")).toBe("npx @getengram/cli stop");
    cli.worker = NPX;
    cli.loginStart = INSTALLED;
    expect(engramCommand("stop")).toBe("engram stop");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    expect(engramCommand("stop")).toBe("npx @getengram/cli stop");
  });
});

/**
 * engram#727 — what the CLI and its daemon say to run goes through
 * engramCommand, which names it as the CLI was run. A message that spells
 * out `engram <command>` itself names a command the shell can't find when
 * npx runs the CLI. Kept as they are, each for its reason below.
 */
describe("what the CLI says to run (engram#727)", () => {
  const SRC = join(__dirname, "..");
  const COMMAND =
    /\bengram (?:help|version|signup|login|logout|link|whoami|auth|conversations|convs|store|append|search|find|log|import|upgrade|usage|status|vault|exclude|start|stop|install|uninstall)\b/;
  // Usage synopses name the program, as help does.
  const SYNOPSIS = /\bUsage: engram /g;
  // Each with how many times it is said: one more is a message that names a
  // command itself, behind text kept for a reason.
  const KEPT: Record<string, Record<string, number>> = {
    // Examples, in help and under a synopsis: they name the program too.
    "index.ts": {
      "  engram signup": 1,
      "  engram login": 1,
      '  engram conversations create --title "My Chat" --tags dev,test': 1,
      '  engram store -c conv_abc "deployed v2.1 to production"': 1,
      '  engram search "when did we deploy"': 1,
    },
    "commands/auth.ts": { "  engram auth login engram_sk_live_iqbm...": 1 },
    "commands/import.ts": { "  engram import https://chatgpt.com/share/<id>": 1 },
    "commands/search.ts": {
      '  engram search "deployment to production"': 1,
      '  engram search "user preferences" --limit 5': 1,
      '  engram search "error handling" --tags prod,api': 1,
    },
    "commands/store.ts": {
      '  engram store -c conv_abc "Hello world"': 1,
      '  echo "content" | engram store -c conv_abc --file -': 1,
      '  engram store -c conv_abc --role assistant "Response text"': 1,
    },
    "commands/vault.ts": { "       echo 'value' | engram vault set <NAME>": 2 },
    // What to run once the CLI is installed, which puts engram on PATH: the
    // runner refusal's "Then run:", and how to start it at login.
    "daemon/commands.ts": {
      '"engram install"': 3,
      '"engram start --install"': 2,
      "${INSTALL_CLI} && engram install": 1,
    },
    // What happened, not what to run: a stop request, from whichever CLI.
    "daemon/instance.ts": { "stop requested ('engram stop')": 1 },
    "daemon/supervise.ts": { "stopped by 'engram stop'": 1 },
    // What an older CLI ran as root (engram#680).
    "daemon/root-daemon.ts": { "'sudo engram install'": 2 },
    // The unit's own comment: only the installed CLI writes it (engram#665).
    "daemon/systemd.ts": { "# Written by 'engram install'; 'engram uninstall' removes it.": 1 },
  };

  /** The CLI's sources, tests aside. */
  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sources(path);
      return entry.name.endsWith(".ts") ? [path] : [];
    });
  }

  it("names no engram command itself: each goes through engramCommand, but those kept for a reason", () => {
    const files = sources(SRC);
    expect(files.length).toBeGreaterThan(20);
    const found: string[] = [];
    const said: Record<string, number> = {};
    for (const file of files) {
      const rel = relative(SRC, file).split(sep).join("/");
      const kept = Object.keys(KEPT[rel] ?? {});
      readFileSync(file, "utf-8")
        .split("\n")
        .forEach((line, i) => {
          // Comments say what the code does, to whoever reads it.
          if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
          let rest = line.replace(SYNOPSIS, "Usage: ");
          for (const text of kept) {
            const parts = rest.split(text);
            if (parts.length === 1) continue;
            said[`${rel}: ${text}`] = (said[`${rel}: ${text}`] ?? 0) + parts.length - 1;
            rest = parts.join("");
          }
          if (COMMAND.test(rest)) found.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(found).toEqual([]);
    // Each kept text as many times as it is kept for: none gone, which would
    // keep what isn't there, and none more, a message that names a command
    // itself in words kept for another reason.
    const kept = Object.fromEntries(
      Object.entries(KEPT).flatMap(([rel, texts]) =>
        Object.entries(texts).map(([text, times]) => [`${rel}: ${text}`, times]),
      ),
    );
    expect(said).toEqual(kept);
  });
});
