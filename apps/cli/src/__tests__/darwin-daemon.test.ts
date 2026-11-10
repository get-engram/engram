import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi, type Mock } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";
import type { Probe } from "../daemon/instance.js";
import type { PlistPaths } from "../daemon/launchd.js";

/**
 * engram#616 — start at login on macOS: the launchd agent,
 * ~/Library/LaunchAgents/app.getengram.daemon.plist.
 *
 * These run the macOS code paths on any OS: process.platform is switched to
 * darwin, launchctl is a fake that loads and unloads the agent as launchd
 * does, the home directory is a temp dir, and nothing reaches the real
 * launchd, ~/Library/LaunchAgents or ~/.engram. On a Mac, plutil reads the
 * plists back too (read-only, temp files).
 */

const { home, cli, daemon, launchd, spawn, execSync, execFileSync } = vi.hoisted(() => ({
  home: { dir: "" },
  // This build's worker, when it isn't the one in the test's home: a CLI
  // installed with brew runs from a versioned keg (engram#652).
  cli: { worker: null as string | null },
  // What answers on the daemon's socket: a daemon, or nothing. `silent`:
  // something holds it and doesn't answer, as a daemon busy starting does.
  daemon: { answering: null as { pid: number } | null, silent: false },
  // The fake launchd: the job it has loaded, and what it refuses.
  launchd: {
    loaded: false,
    /** The daemon launchd runs for the job, when it runs one. */
    pid: null as number | null,
    /** The plist as it was when launchd loaded it: launchd keeps that one. */
    loadedText: null as string | null,
    /** What `list` prints instead, when set. */
    listOutput: null as string | null,
    /**
     * Whether ~/.engram/daemon.log was there when launchd last loaded the
     * job: launchd opens it for the job, and makes a missing one 0644
     * (engram#627).
     */
    logAtLoad: null as boolean | null,
    bootstrapFails: false,
    loadFails: false,
    bootoutFails: false,
    /** How many `list` calls after a bootout still find the job, while launchd lets go of it. */
    stillLoadedFor: 0,
    lingering: 0,
    /**
     * launchd's switch for the job, which it keeps with the plist gone
     * (engram#654): `launchctl disable` (or `unload -w`) switches it off,
     * `enable` (or `load -w`) on. null: neither ever, so print-disabled
     * doesn't list it. A job switched off stays loaded until it is unloaded,
     * but launchd loads it no more.
     */
    switchedOff: null as boolean | null,
    /** What `print-disabled` prints instead, when set. */
    disabledOutput: null as string | null,
    printDisabledFails: false,
    enableFails: false,
    /** Calls the fake didn't expect; each fails the test. */
    unexpected: [] as string[],
  },
  spawn: vi.fn(),
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn,
  execSync,
  execFileSync,
  execFile: vi.fn(),
}));
vi.mock("../config.js", () => {
  const loadConfigStrict = vi.fn(async () => ({}));
  return {
    loadConfigStrict,
    saveConfig: vi.fn(async () => {}),
    getBaseUrl: () => "https://engram.invalid",
    resolveBaseUrl: () => "https://engram.invalid",
  };
});
// An install has dist/daemon/worker.js beside launch.js; under vitest the
// module beside launch.ts is worker.ts. Point at a file that exists.
vi.mock("../daemon/launch.js", async (importOriginal) => {
  const path = await import("node:path");
  return {
    ...(await importOriginal<typeof import("../daemon/launch.js")>()),
    workerPath: () => cli.worker ?? path.join(home.dir, "cli", "dist", "daemon", "worker.js"),
  };
});
// The probe answers from `daemon.answering`; the rest is the real module.
vi.mock("../daemon/instance.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../daemon/instance.js")>();
  const probeDaemon = async (): Promise<Probe> => {
    if (daemon.silent) return { state: "silent" };
    const a = daemon.answering;
    if (a === null) return { state: "none", stale: false };
    return { state: "answered", info: { ready: true, stopping: false, stopFile: false, version: real.VERSION, ...a } };
  };
  return { ...real, probeDaemon };
});

/** The OS this runs on: the tests say darwin, whatever it is. */
const HOST = process.platform;
const posixIt = HOST === "win32" ? it.skip : it;
/** For a test of file permissions, which root and Windows don't keep to. */
const permissionsIt = HOST === "win32" || process.getuid?.() === 0 ? it.skip : it;
/** For a test that asks macOS itself. */
const macIt = HOST === "darwin" ? it : it.skip;

home.dir = mkdtempSync(join(tmpdir(), "engram-616-"));
const AGENTS = join(home.dir, "Library", "LaunchAgents");
const PLIST = join(AGENTS, "app.getengram.daemon.plist");
const BIN = join(home.dir, "bin");
const NO_BIN = join(home.dir, "no-bin");
const LAUNCHCTL = join(BIN, "launchctl");
const ENGRAM_DIR = join(home.dir, ".engram");
const PID_FILE = join(ENGRAM_DIR, "daemon.pid");
const WORKER = join(home.dir, "cli", "dist", "daemon", "worker.js");
const LABEL = "app.getengram.daemon";
/** The user's login session, as launchd.ts names it. */
const DOMAIN = `gui/${process.getuid?.() ?? 0}`;
mkdirSync(dirname(WORKER), { recursive: true });
mkdirSync(BIN);
mkdirSync(NO_BIN);
// Never run: execFileSync is the fake below. It is there to be found on PATH.
writeFileSync(LAUNCHCTL, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

const { LOG_FILE } = await import("../daemon/launch.js");
const { loadConfigStrict } = await import("../config.js");
const {
  autoEnableCapture,
  daemonInstall,
  daemonStart,
  daemonStatus,
  daemonUninstall,
  repairLaunchdIfStale,
} = await import("../daemon/commands.js");
const {
  PLIST_VERSION,
  agentDisabled,
  agentPid,
  disabledIn,
  generatePlist,
  launchctlPath,
  pathsIn,
  plistPath,
  readPlist,
  refusedByLaunchd,
  reloadAgent,
  writePlistFile,
  xmlText,
} = await import("../daemon/launchd.js");
const { commandFailure } = await import("../daemon/command-path.js");
const { throughOptLink } = await import("../daemon/homebrew.js");

/** Node as start at login names it: through Homebrew's opt link, when it runs from a keg (engram#652). */
const NODE = throughOptLink(realpathSync.native(process.execPath));
/** The plist's paths for this CLI, as `engram install` writes them. */
const THIS_CLI: PlistPaths = {
  node: NODE,
  worker: WORKER,
  log: LOG_FILE,
  home: home.dir,
  path: `${dirname(NODE)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
};

/** The stamp a plist says its version with. */
function stamp(version: number): string {
  return `<key>ENGRAM_PLIST_VERSION</key>\n    <string>${version}</string>`;
}

/** A plist of ours, for these paths and this version. */
function plistWith(paths: Partial<PlistPaths> = {}, version = PLIST_VERSION): string {
  // A function, so that a `$` in a path is put back as it is.
  return generatePlist({ ...THIS_CLI, ...paths }).replace(stamp(PLIST_VERSION), () => stamp(version));
}

/** A plist as CLIs before v2 wrote one: no PATH, no stamp. */
function asV1(text: string): string {
  const v1 = text.replace(
    /\n    <key>PATH<\/key>\n    <string>[^<]*<\/string>\n    <key>ENGRAM_PLIST_VERSION<\/key>\n    <string>\d+<\/string>/,
    () => "",
  );
  if (v1 === text) throw new Error("not a plist of ours");
  return v1;
}

/** The plist CLIs before v2 wrote for this one: the worker-main.js entry point (engram#469). */
function v1Plist(): string {
  return asV1(plistWith({ worker: join(dirname(WORKER), "worker-main.js") }));
}

/** Put `text` where the plist goes, as a file with this mode. */
function writePlist(text: string | Uint8Array, mode = 0o644): void {
  mkdirSync(dirname(plistPath()), { recursive: true });
  rmSync(plistPath(), { recursive: true, force: true });
  writeFileSync(plistPath(), text);
  chmodSync(plistPath(), mode);
}

/**
 * A home named `name`, inside the test's own, with this build's worker in it.
 * Gives back what puts the home back.
 */
function homeNamed(name: string): () => void {
  const dir = home.dir;
  home.dir = join(dir, name);
  rmSync(home.dir, { recursive: true, force: true });
  const worker = join(home.dir, "cli", "dist", "daemon", "worker.js");
  mkdirSync(dirname(worker), { recursive: true });
  writeFileSync(worker, "");
  return () => {
    home.dir = dir;
  };
}

function failed(command: string, stderr: string): Error {
  return Object.assign(new Error(`Command failed: ${command}`), { status: 1, stderr });
}

/** What `launchctl list <label>` prints for a job launchd has. */
function listing(): string {
  return (
    "{\n" +
    '\t"LimitLoadToSessionType" = "Aqua";\n' +
    `\t"Label" = "${LABEL}";\n` +
    '\t"OnDemand" = false;\n' +
    '\t"LastExitStatus" = 0;\n' +
    (launchd.pid === null ? "" : `\t"PID" = ${launchd.pid};\n`) +
    "};\n"
  );
}

/**
 * What `launchctl print-disabled gui/<uid>` prints: each job launchd has a
 * switch for. Another job's, and one whose label starts with ours, which
 * isn't ours.
 */
function disabledListing(): string {
  const ours =
    launchd.switchedOff === null ? "" : `\t\t"${LABEL}" => ${launchd.switchedOff ? "disabled" : "enabled"}\n`;
  return `\n\tdisabled services = {\n\t\t"com.example.agent" => disabled\n${ours}\t\t"${LABEL}.helper" => disabled\n\t}\n`;
}

function load(plist: string): void {
  launchd.loaded = true;
  launchd.loadedText = readFileSync(plist, "utf-8");
  launchd.logAtLoad = existsSync(LOG_FILE);
}

function unload(): void {
  launchd.loaded = false;
  launchd.pid = null;
  launchd.lingering = launchd.stillLoadedFor;
}

/** launchctl, against the fake launchd above: what the real one does with it. */
function fakeLaunchctl(file: string, args: string[]): string {
  const command = args.join(" ");
  if (file !== LAUNCHCTL) {
    launchd.unexpected.push(`${file} ${command}`);
    throw new Error(`unexpected program ${file}`);
  }
  // Where the plist is for the home of the moment: a test can change it.
  const plist = join(home.dir, "Library", "LaunchAgents", `${LABEL}.plist`);
  const is = (...expected: string[]) =>
    args.length === expected.length && args.every((arg, i) => arg === expected[i]);
  if (is("list", LABEL)) {
    if (launchd.loaded) return launchd.listOutput ?? listing();
    if (launchd.lingering > 0) {
      launchd.lingering--;
      return listing();
    }
    throw failed(command, `Could not find service "${LABEL}" in domain for port\n`);
  }
  if (is("bootstrap", DOMAIN, plist)) {
    if (launchd.switchedOff) throw failed(command, "Bootstrap failed: 119: Service is disabled\n");
    if (launchd.bootstrapFails || launchd.loaded || launchd.lingering > 0 || !existsSync(plist)) {
      throw failed(command, "Bootstrap failed: 5: Input/output error\n");
    }
    load(plist);
    return "";
  }
  if (is("load", "-w", plist) || is("load", plist)) {
    // -w switches the job on first, whether or not it then loads.
    if (args[1] === "-w") launchd.switchedOff = false;
    if (launchd.switchedOff) throw failed(command, "Load failed: 119: Service is disabled\n");
    if (launchd.loadFails || launchd.loaded || launchd.lingering > 0 || !existsSync(plist)) {
      throw failed(command, "Load failed: 5: Input/output error\nTry running `launchctl bootstrap` as root for richer errors.\n");
    }
    load(plist);
    return "";
  }
  if (is("print-disabled", DOMAIN)) {
    if (launchd.printDisabledFails) throw failed(command, "Could not find domain for port\n");
    return launchd.disabledOutput ?? disabledListing();
  }
  if (is("enable", `${DOMAIN}/${LABEL}`)) {
    if (launchd.enableFails) throw failed(command, "Could not enable service: 1: Operation not permitted\n");
    launchd.switchedOff = false;
    return "";
  }
  if (is("bootout", `${DOMAIN}/${LABEL}`)) {
    if (launchd.bootoutFails || !launchd.loaded) throw failed(command, "Boot-out failed: 3: No such process\n");
    unload();
    return "";
  }
  if (is("unload", plist)) {
    if (!launchd.loaded) throw failed(command, "Unload failed: 113: Could not find specified service\n");
    unload();
    return "";
  }
  launchd.unexpected.push(command);
  throw new Error(`unexpected launchctl ${command}`);
}

/** The fake launchctl's calls, by their first word. */
function launchctlCalls(): string[] {
  return execFileSync.mock.calls.map(([, args]) => (args as string[])[0]);
}

/** The fake launchctl's loads, as their arguments: never -w but for `engram install` (engram#654). */
function loads(): string[] {
  return execFileSync.mock.calls
    .map(([, args]) => (args as string[]).join(" "))
    .filter((command) => command.startsWith("load "));
}

/** A spawned worker, as far as the CLI looks at one. */
function fakeChild() {
  return Object.assign(new EventEmitter(), { pid: process.pid, unref: vi.fn() });
}

/** A worker that exits with an error as it starts, as Node does without its script. */
function failingSpawn() {
  const child = fakeChild();
  setImmediate(() => child.emit("exit", 1));
  return child;
}

/** A worker that starts and answers on the socket, ready. */
function fakeSpawn() {
  daemonRunning();
  return fakeChild();
}

/** A daemon: it answers on the socket and wrote its PID file. This process stands in for it. */
function daemonRunning(): void {
  mkdirSync(ENGRAM_DIR, { recursive: true });
  writeFileSync(PID_FILE, String(process.pid));
  daemon.answering = { pid: process.pid };
}

/** The daemon is gone, as after a restart. */
function daemonGone(): void {
  daemon.answering = null;
  rmSync(PID_FILE, { force: true });
}

/** Signal 0 finds this process alive; any other signal fails the test before it reaches a process. */
function fakeKill(pid: number, signal: string | number = "SIGTERM"): true {
  if (signal === 0 && pid === process.pid) return true;
  if (signal === 0) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
  throw new Error(`a test sent ${String(signal)} to pid ${pid}`);
}

function output(): string {
  return [console.log as Mock, console.error as Mock]
    .flatMap((m) => m.mock.calls.map((c) => c.join(" ")))
    .join("\n");
}

/** What was said since the last call. */
function said(): string {
  const text = output();
  vi.mocked(console.log).mockClear();
  vi.mocked(console.error).mockClear();
  return text;
}

/**
 * Auto-capture runs, in the describe this is called in: signed in, at a
 * terminal, without what the test run itself sets to keep auto-capture out
 * of other tests.
 */
function signedInAtATerminal(): void {
  const realIsTTY = process.stdin.isTTY;
  const config = vi.mocked(loadConfigStrict);

  beforeEach(() => {
    vi.stubEnv("ENGRAM_NO_AUTOCAPTURE", "");
    vi.stubEnv("ENGRAM_API_KEY", undefined);
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    config.mockResolvedValue({ apiKey: "eng_test_616" } as never);
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: realIsTTY, configurable: true });
    config.mockReset().mockImplementation(async () => ({}) as never);
  });
}

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  Object.assign(launchd, {
    loaded: false,
    pid: null,
    loadedText: null,
    listOutput: null,
    logAtLoad: null,
    bootstrapFails: false,
    loadFails: false,
    bootoutFails: false,
    stillLoadedFor: 0,
    lingering: 0,
    switchedOff: null,
    disabledOutput: null,
    printDisabledFails: false,
    enableFails: false,
    unexpected: [],
  });
  daemon.answering = null;
  daemon.silent = false;
  cli.worker = null;
  rmSync(join(home.dir, "Library"), { recursive: true, force: true });
  rmSync(PID_FILE, { force: true });
  writeFileSync(WORKER, "");
  vi.stubEnv("PATH", BIN);
  spawn.mockReset().mockImplementation(fakeSpawn);
  execSync.mockReset();
  execFileSync.mockReset().mockImplementation(fakeLaunchctl);
  vi.spyOn(process, "kill").mockImplementation(fakeKill);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: HOST, configurable: true });
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // launchctl only ever through execFileSync, never a shell command line,
  // and only the calls the fake knows.
  expect(execSync).not.toHaveBeenCalled();
  expect(launchd.unexpected).toEqual([]);
});

afterAll(() => rmSync(home.dir, { recursive: true, force: true }));

describe("the tests' own home (engram#616)", () => {
  it("is a temporary one: nothing here reaches the real ~/Library/LaunchAgents, ~/.engram or launchctl", () => {
    expect(realpathSync(dirname(home.dir))).toBe(realpathSync(tmpdir()));
    expect(plistPath()).toBe(PLIST);
    expect(LOG_FILE).toBe(join(ENGRAM_DIR, "daemon.log"));
    expect(launchctlPath()).toBe(LAUNCHCTL);
  });
});

describe("the plist (engram#616)", () => {
  const paths: PlistPaths = {
    node: "/opt/homebrew/Cellar/node/24.1.0/bin/node",
    worker: "/opt/homebrew/lib/node_modules/@getengram/cli/dist/daemon/worker.js",
    log: "/Users/op/.engram/daemon.log",
    home: "/Users/op",
    path: "/opt/homebrew/Cellar/node/24.1.0/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  };

  it("is what launchd is given", () => {
    expect(generatePlist(paths)).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>app.getengram.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/Cellar/node/24.1.0/bin/node</string>
    <string>/opt/homebrew/lib/node_modules/@getengram/cli/dist/daemon/worker.js</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/op/.engram/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/op/.engram/daemon.log</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>/Users/op</string>
    <key>PATH</key>
    <string>/opt/homebrew/Cellar/node/24.1.0/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>ENGRAM_PLIST_VERSION</key>
    <string>2</string>
  </dict>
</dict>
</plist>`);
  });

  it("gives every path back as it is, whatever is in it", () => {
    for (const odd of [
      "/Users/A&B",
      "/Users/a<b>c",
      `/Users/"double" 'single'`,
      "/Users/&amp;", // already looks escaped
      "/Users/&lt;x&gt;",
      "/Users/&#38;",
      "/Users/x]]>y",
      "/Users/$HOME %h",
      "/Users/Jürgen 😀",
      `/Users/${"x".repeat(1000)}`,
    ]) {
      for (const key of ["node", "worker", "log", "home", "path"] as const) {
        expect(pathsIn(generatePlist({ ...paths, [key]: odd }))).toEqual({ ...paths, [key]: odd });
      }
    }
  });

  it("escapes &, < and >, as macOS's own plist writer does, and nothing else", () => {
    expect(xmlText(`a&b<c>d"e'f]]>`)).toBe(`a&amp;b&lt;c&gt;d"e'f]]&gt;`);
    expect(xmlText("&amp;")).toBe("&amp;amp;");
    expect(xmlText("Jürgen 😀")).toBe("Jürgen 😀");
  });

  it("refuses a path with a control character in it, or one that isn't Unicode", () => {
    for (const c of ["\x00", "\t", "\n", "\r", "\x1b", "\x7f"]) {
      const bad = `/Users/a${c}b`;
      // As JSON: never a raw control character in what is said.
      expect(() => xmlText(bad)).toThrow(`a path with a control character in it: ${JSON.stringify(bad)}`);
      for (const key of ["node", "worker", "log", "home", "path"] as const) {
        expect(() => generatePlist({ ...paths, [key]: bad })).toThrow("a path with a control character in it");
      }
    }
    for (const half of ["\ud800", "\udc00x", "\udc00\ud800"]) {
      const bad = `/Users/${half}`;
      expect(() => xmlText(bad)).toThrow(`a path that isn't valid Unicode: ${JSON.stringify(bad)}`);
    }
    expect(xmlText("/Users/😀")).toBe("/Users/😀");
  });

  it("reads back nothing it wouldn't write", () => {
    const text = generatePlist(paths);
    expect(pathsIn(text)).toEqual(paths);
    const amp = generatePlist({ ...paths, home: "/Users/A&B" });
    for (const other of [
      amp.replace("&amp;", () => "&"), // raw, as CLIs before engram#616 wrote it
      amp.replace("&amp;", () => "&#38;"),
      generatePlist({ ...paths, home: `/Users/A"B` }).replace(`A"B`, () => "A&quot;B"),
      text.replace(`<string>${LABEL}</string>`, () => "<string>app.getengram.other</string>"),
      text.replace("<string>/Users/op</string>", () => "<string>/Users/o\tp</string>"), // xmlText refuses a tab
      `${text}\n`,
      text.replace(/\n/g, () => "\r\n"),
      `﻿${text}`,
      text.replace(/(<key>StandardErrorPath<\/key>\n {2}<string>)[^<]*/, (_, key: string) => `${key}/tmp/other.log`),
      asV1(text),
      text.replace(stamp(PLIST_VERSION), () => stamp(PLIST_VERSION + 1)),
      text.replace("  <key>ThrottleInterval</key>", () => "  <key>Nice</key>\n  <integer>1</integer>\n  <key>ThrottleInterval</key>"),
    ]) {
      expect(other).not.toBe(text);
      expect(pathsIn(other)).toBeNull();
    }
  });

  it("is put in place whole or not at all, and a write that fails leaves nothing behind", () => {
    // A directory in its place, which a file can't be renamed over.
    mkdirSync(join(PLIST, "x"), { recursive: true });
    expect(() => writePlistFile(plistWith())).toThrow();
    expect(readdirSync(AGENTS)).toEqual(["app.getengram.daemon.plist"]);
    expect(statSync(PLIST).isDirectory()).toBe(true);
  });
});

describe("reading the plist (engram#616)", () => {
  it("finds none where there is none", () => {
    expect(readPlist()).toEqual({ kind: "none" });
    // ~/Library/LaunchAgents a file, not a directory.
    mkdirSync(join(home.dir, "Library"), { recursive: true });
    writeFileSync(AGENTS, "");
    expect(readPlist()).toEqual({ kind: "none" });
  });

  it("finds a current one", () => {
    writePlist(plistWith());
    expect(readPlist()).toEqual({ kind: "ours", broken: false, version: PLIST_VERSION, outdated: false });
  });

  it("finds one whose Node or worker is gone broken", () => {
    for (const gone of [{ node: join(home.dir, "gone", "node") }, { worker: join(home.dir, "gone", "worker.js") }]) {
      writePlist(plistWith(gone));
      expect(readPlist()).toEqual({ kind: "ours", broken: true, version: PLIST_VERSION, outdated: false });
    }
  });

  it("finds one with a raw < in it broken, as CLIs before engram#616 wrote one: launchd can't load it", () => {
    writePlist(plistWith({ home: "/Users/a<b" }).replace("&lt;", () => "<"));
    expect(readPlist()).toEqual({ kind: "ours", broken: true, version: PLIST_VERSION, outdated: false });
  });

  it("finds one that isn't UTF-8, or isn't a file, broken", () => {
    writePlist(Buffer.concat([Buffer.from(plistWith()), Buffer.from([0xff])]));
    expect(readPlist()).toEqual({ kind: "ours", broken: true, version: 1, outdated: true });
    rmSync(PLIST);
    mkdirSync(PLIST);
    expect(readPlist()).toEqual({ kind: "ours", broken: true, version: 1, outdated: true });
  });

  permissionsIt("finds one others can write broken: launchd won't load it", () => {
    for (const mode of [0o664, 0o646]) {
      writePlist(plistWith(), mode);
      expect(readPlist()).toEqual({ kind: "ours", broken: true, version: PLIST_VERSION, outdated: false });
    }
    writePlist(v1Plist(), 0o664);
    expect(readPlist()).toEqual({ kind: "ours", broken: true, version: 1, outdated: true });
  });

  permissionsIt("finds one it can't read broken", () => {
    writePlist(plistWith(), 0o000);
    expect(readPlist()).toEqual({ kind: "ours", broken: true, version: 1, outdated: true });
  });

  it("reads past a byte order mark, as launchd does", () => {
    writePlist(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(plistWith())]));
    expect(readPlist()).toEqual({ kind: "ours", broken: false, version: PLIST_VERSION, outdated: false });
  });

  posixIt("knows which launchd won't load: one others can write, or one someone else owns, unless root", () => {
    vi.spyOn(process, "getuid").mockReturnValue(501);
    const file = (uid: number, mode: number) => ({ uid, mode: 0o100000 | mode });
    expect(refusedByLaunchd(file(501, 0o644))).toBe(false);
    expect(refusedByLaunchd(file(501, 0o600))).toBe(false);
    expect(refusedByLaunchd(file(0, 0o644))).toBe(false);
    expect(refusedByLaunchd(file(502, 0o644))).toBe(true);
    expect(refusedByLaunchd(file(501, 0o664))).toBe(true);
    expect(refusedByLaunchd(file(501, 0o646))).toBe(true);
    expect(refusedByLaunchd(file(0, 0o664))).toBe(true);
  });

  it("finds an older one outdated, not broken: start rewrites it all the same", () => {
    writePlist(v1Plist());
    expect(readPlist()).toEqual({ kind: "ours", broken: false, version: 1, outdated: true });
  });

  it("leaves a newer one to the CLI that wrote it", () => {
    writePlist(plistWith({ node: join(home.dir, "gone", "node") }, PLIST_VERSION + 1));
    expect(readPlist()).toEqual({ kind: "ours", broken: false, version: PLIST_VERSION + 1, outdated: false });
  });
});

describe("launchctl (engram#616)", () => {
  it("is found on PATH", () => {
    vi.stubEnv("PATH", [NO_BIN, BIN].join(delimiter));
    expect(launchctlPath()).toBe(LAUNCHCTL);
    vi.stubEnv("PATH", NO_BIN);
    expect(launchctlPath()).toBeNull();
    vi.stubEnv("PATH", undefined);
    expect(launchctlPath()).toBeNull();
  });

  it("is never found through a relative directory on PATH", () => {
    // Relative to the working directory, this one is BIN.
    const rel = relative(process.cwd(), BIN);
    vi.stubEnv("PATH", rel);
    // Where the temp dir is on another drive, there is no relative path to it.
    expect(launchctlPath()).toBe(isAbsolute(rel) ? LAUNCHCTL : null);
  });

  posixIt("is a file that can be run", () => {
    const dir = join(home.dir, "other-bin");
    mkdirSync(join(dir, "launchctl"), { recursive: true }); // a directory
    const notRunnable = join(home.dir, "plain-bin");
    mkdirSync(notRunnable, { recursive: true });
    writeFileSync(join(notRunnable, "launchctl"), "", { mode: 0o644 });
    vi.stubEnv("PATH", [dir, notRunnable, BIN].join(delimiter));
    expect(launchctlPath()).toBe(LAUNCHCTL);
  });

  it("is given arguments, never a command line, and given up on when it hangs", async () => {
    await daemonInstall();
    expect(execFileSync).toHaveBeenCalled();
    for (const [file, args, options] of execFileSync.mock.calls) {
      expect(file).toBe(LAUNCHCTL);
      expect(Array.isArray(args)).toBe(true);
      expect(options).toMatchObject({ encoding: "utf-8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
      expect(options).not.toHaveProperty("shell");
    }
  });

  it("says what went wrong in a line: the first it said, or else the first of the error", () => {
    const stderr = "\n  \nLoad failed: 5: Input/output error\nTry running `launchctl bootstrap` as root for richer errors.\n";
    expect(commandFailure(failed("launchctl load -w x.plist", stderr))).toBe("Load failed: 5: Input/output error");
    expect(commandFailure(failed("launchctl list", ""))).toBe("Command failed: launchctl list");
    expect(commandFailure(failed("launchctl list", "\n \n"))).toBe("Command failed: launchctl list");
    expect(commandFailure(new Error("spawnSync launchctl ETIMEDOUT\n    at x"))).toBe("spawnSync launchctl ETIMEDOUT");
    expect(commandFailure(failed("launchctl list", `${"x".repeat(200)}\n`))).toBe("x".repeat(200));
    expect(commandFailure(failed("launchctl list", `${"x".repeat(201)}\n`))).toBe(`${"x".repeat(199)}…`);
  });

  it("names the daemon launchd runs, either way it prints it", () => {
    launchd.loaded = true;
    launchd.pid = 4242;
    expect(agentPid()).toBe(4242);
    launchd.listOutput = `4243\t0\t${LABEL}\n`;
    expect(agentPid()).toBe(4243);
    launchd.listOutput = `-\t0\t${LABEL}\n`;
    expect(agentPid()).toBeNull();
    launchd.listOutput = null;
    launchd.pid = null;
    expect(agentPid()).toBeNull();
    launchd.loaded = false;
    expect(agentPid()).toBeNull();
    expect(launchctlCalls()).toEqual(["list", "list", "list", "list", "list"]);
  });
});

describe("engram install on macOS (engram#616)", () => {
  it("writes the plist and loads it, and launchd starts the daemon", async () => {
    await daemonInstall();
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
    expect(readdirSync(AGENTS)).toEqual(["app.getengram.daemon.plist"]);
    // Any job of ours unloaded first, and gone, then the new one loaded.
    expect(launchctlCalls()).toEqual(["print-disabled", "bootout", "unload", "list", "bootstrap"]);
    expect(launchd.loadedText).toBe(plistWith());
    // launchd starts it (RunAtLoad), not the CLI.
    expect(spawn).not.toHaveBeenCalled();
    const text = output();
    expect(text).toContain("Auto-start enabled — daemon will start on login");
    expect(text).toContain(`Plist: ${PLIST}`);
    expect(process.exitCode).toBeUndefined();
    expect(readPlist()).toEqual({ kind: "ours", broken: false, version: PLIST_VERSION, outdated: false });
  });

  posixIt("writes it 0644 whatever the umask: launchd won't load one others can write", async () => {
    for (const mask of [0o077, 0o002]) {
      rmSync(join(home.dir, "Library"), { recursive: true, force: true });
      launchd.loaded = false;
      const umask = process.umask(mask);
      try {
        await daemonInstall();
      } finally {
        process.umask(umask);
      }
      expect(statSync(PLIST).mode & 0o777).toBe(0o644);
    }
  });

  posixIt("escapes a home with &, < and > in it, which then reads back as it is", async () => {
    const restore = homeNamed("A&B <C>");
    try {
      await daemonInstall();
      const text = readFileSync(plistPath(), "utf-8");
      expect(text).toContain("A&amp;B &lt;C&gt;");
      expect(pathsIn(text)).toMatchObject({ home: home.dir, worker: join(home.dir, "cli", "dist", "daemon", "worker.js") });
      expect(readPlist()).toEqual({ kind: "ours", broken: false, version: PLIST_VERSION, outdated: false });
      expect(launchd.loadedText).toBe(text);
    } finally {
      restore();
    }
  });

  it("leaves a plist launchd has loaded as it is, and the daemon it runs", async () => {
    writePlist(plistWith());
    launchd.loaded = true;
    daemonRunning();
    await daemonInstall();
    // Not unloaded: that would stop the daemon.
    expect(launchctlCalls()).toEqual(["print-disabled", "list"]);
    expect(output()).toContain("Auto-start enabled — daemon will start on login");
  });

  it("loads one that is there but not loaded", async () => {
    writePlist(plistWith());
    await daemonInstall();
    expect(launchctlCalls()).toEqual(["list", "print-disabled", "list", "bootout", "unload", "list", "bootstrap"]);
    expect(launchd.loaded).toBe(true);
    expect(output()).toContain("Auto-start enabled");
  });

  it("loads one that changed again, so that launchd runs the new one", async () => {
    writePlist(v1Plist());
    launchd.loaded = true;
    launchd.loadedText = v1Plist();
    await daemonInstall();
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
    expect(launchctlCalls()).toEqual(["list", "print-disabled", "bootout", "list", "bootstrap"]);
    expect(launchd.loadedText).toBe(plistWith());
  });

  it("loads it with load -w where bootstrap fails: older macOS, or a job switched off", async () => {
    launchd.bootstrapFails = true;
    await daemonInstall();
    expect(launchctlCalls()).toEqual(["print-disabled", "bootout", "unload", "list", "bootstrap", "load"]);
    expect(loads()).toEqual([`load -w ${PLIST}`]);
    expect(launchd.loaded).toBe(true);
    expect(output()).toContain("Auto-start enabled — daemon will start on login");
  });

  it("says what launchctl said, and how to load it by hand, when it can't load it", async () => {
    launchd.bootstrapFails = true;
    launchd.loadFails = true;
    const restore = homeNamed("O'Brien Q");
    let plist = "";
    try {
      plist = plistPath();
      await daemonInstall();
      expect(pathsIn(readFileSync(plist, "utf-8"))?.home).toBe(home.dir);
    } finally {
      restore();
    }
    const text = output();
    expect(text).toContain(`Plist written to ${plist}`);
    expect(text).toContain("  launchctl: Load failed: 5: Input/output error");
    // One word for the shell, whatever is in the path.
    expect(text).toContain(`Run manually: launchctl load -w '${plist.replace(/'/g, "'\\''")}'`);
    expect(text).not.toContain("Auto-start enabled");
    expect(process.exitCode).toBeUndefined();
  });

  it("says so when launchctl isn't on PATH", async () => {
    vi.stubEnv("PATH", NO_BIN);
    await daemonInstall();
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
    expect(output()).toContain("  launchctl: launchctl isn't on PATH");
    expect(execFileSync).not.toHaveBeenCalled();
  });

  posixIt("replaces a link in the plist's place, and never writes through it", async () => {
    const target = join(home.dir, "elsewhere.plist");
    writeFileSync(target, v1Plist());
    mkdirSync(AGENTS, { recursive: true });
    symlinkSync(target, PLIST);
    try {
      await daemonInstall();
      expect(lstatSync(PLIST).isFile()).toBe(true);
      expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
      expect(readFileSync(target, "utf-8")).toBe(v1Plist());
      expect(launchctlCalls()).toEqual(["list", "print-disabled", "bootout", "unload", "list", "bootstrap"]);
    } finally {
      rmSync(target, { force: true });
    }
  });

  it("fails when this build has no worker to start", async () => {
    rmSync(WORKER);
    await daemonInstall();
    expect(existsSync(PLIST)).toBe(false);
    expect(output()).toContain(`Can't turn on start at login: ${WORKER} is missing.`);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  posixIt("refuses a home a plist can't hold, says why, and writes nothing", async () => {
    const restore = homeNamed("new\nline");
    try {
      await daemonInstall();
    } finally {
      restore();
    }
    expect(existsSync(join(home.dir, "new\nline", "Library"))).toBe(false);
    const text = output();
    expect(text).toContain("Can't turn on start at login: a launchd job can't hold one of the paths it needs.");
    // The worker's path as JSON: never a raw control character on the terminal.
    expect(text).toContain(JSON.stringify(join(home.dir, "new\nline", "cli", "dist", "daemon", "worker.js")));
    expect(text).not.toContain("new\nline");
    expect(execFileSync).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  permissionsIt("says why when it can't write the plist, and leaves nothing behind", async () => {
    mkdirSync(AGENTS, { recursive: true });
    chmodSync(AGENTS, 0o555);
    try {
      await daemonInstall();
    } finally {
      chmodSync(AGENTS, 0o755);
    }
    expect(readdirSync(AGENTS)).toEqual([]);
    const text = output();
    expect(text).toContain("Couldn't turn on start at login.");
    expect(text).toContain("EACCES");
    expect(execFileSync).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("turns start at login on with start --install while the daemon runs, and starts no other", async () => {
    daemonRunning();
    await daemonStart([], { install: "" });
    expect(spawn).not.toHaveBeenCalled();
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
    expect(launchctlCalls()).toEqual(["print-disabled", "bootout", "unload", "list", "bootstrap"]);
    const text = output();
    expect(text).toContain("Daemon already running");
    expect(text).toContain("Auto-start enabled — daemon will start on login");
  });
});

describe("engram start on macOS (engram#616)", () => {
  it("updates an older plist, and has launchd load the new one in its place (engram#469)", async () => {
    writePlist(v1Plist());
    launchd.loaded = true;
    launchd.loadedText = v1Plist();
    await daemonStart([], {});
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
    expect(launchd.loadedText).toBe(plistWith());
    expect(launchctlCalls()).toEqual(["list", "print-disabled", "bootout", "list", "bootstrap"]);
    expect(output()).toContain(`Updated auto-start configuration (plist v${PLIST_VERSION})`);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
  });

  it("rewrites a plist launchd can't start the daemon from", async () => {
    for (const text of [
      plistWith({ home: "/Users/a<b" }).replace("&lt;", () => "<"), // launchd can't load it
      plistWith({ path: "/opt/A&B/bin:/usr/bin" }).replace("&amp;", () => "&"), // nothing else can read it
      plistWith({ node: join(home.dir, "gone", "node") }),
      plistWith({ worker: join(home.dir, "gone", "worker.js") }),
      Buffer.concat([Buffer.from(plistWith()), Buffer.from([0xff])]),
      "<plist/>",
    ]) {
      writePlist(text);
      daemonGone();
      await daemonStart([], {});
      expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
      expect(launchd.loadedText).toBe(plistWith());
      expect(said()).toContain("Updated auto-start configuration");
    }
    expect(spawn).toHaveBeenCalledTimes(6);
  });

  permissionsIt("rewrites one others can write 0644, which launchd then loads", async () => {
    writePlist(plistWith(), 0o664);
    await daemonStart([], {});
    expect(statSync(PLIST).mode & 0o777).toBe(0o644);
    expect(readPlist()).toEqual({ kind: "ours", broken: false, version: PLIST_VERSION, outdated: false });
    expect(launchd.loaded).toBe(true);
  });

  it("leaves a current plist, and a newer CLI's, as they are", async () => {
    for (const text of [plistWith(), plistWith({ node: join(home.dir, "gone", "node") }, PLIST_VERSION + 1)]) {
      writePlist(text);
      daemonGone();
      execFileSync.mockClear();
      await daemonStart([], {});
      expect(readFileSync(PLIST, "utf-8")).toBe(text);
      // Only the look for a daemon launchd runs.
      expect(launchctlCalls()).toEqual(["list"]);
      expect(said()).not.toContain("Updated auto-start configuration");
    }
  });

  it("leaves the plist alone off macOS, as in a home shared with Linux", () => {
    writePlist(v1Plist());
    for (const platform of ["linux", "win32"]) {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      expect(repairLaunchdIfStale()).toBe(false);
    }
    expect(readFileSync(PLIST, "utf-8")).toBe(v1Plist());
    expect(execFileSync).not.toHaveBeenCalled();
  });

  permissionsIt("says nothing of an update it couldn't write, and starts the daemon all the same", async () => {
    writePlist(v1Plist());
    chmodSync(AGENTS, 0o555);
    try {
      await daemonStart([], {});
    } finally {
      chmodSync(AGENTS, 0o755);
    }
    expect(readFileSync(PLIST, "utf-8")).toBe(v1Plist());
    expect(readdirSync(AGENTS)).toEqual(["app.getengram.daemon.plist"]);
    expect(launchctlCalls()).toEqual(["list", "print-disabled"]);
    expect(output()).not.toContain("Updated auto-start configuration");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  posixIt("starts the daemon all the same when a plist can't hold this home, and leaves the plist as it is", async () => {
    const restore = homeNamed("new\nline");
    let plist = "";
    try {
      plist = plistPath();
      writePlist(v1Plist());
      await daemonStart([], {});
    } finally {
      restore();
    }
    expect(readFileSync(plist, "utf-8")).toBe(v1Plist());
    expect(output()).not.toContain("Updated auto-start configuration");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
  });

  it("leaves the plist as it is when this build has no worker", async () => {
    writePlist(v1Plist());
    rmSync(WORKER);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    spawn.mockImplementation(failingSpawn);
    await daemonStart([], {});
    expect(readFileSync(PLIST, "utf-8")).toBe(v1Plist());
    expect(output()).not.toContain("Updated auto-start configuration");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("waits for launchd to let go of the old job before it loads the new one", async () => {
    writePlist(v1Plist());
    launchd.loaded = true;
    launchd.stillLoadedFor = 3;
    await daemonStart([], {});
    expect(launchctlCalls()).toEqual(["list", "print-disabled", "bootout", "list", "list", "list", "list", "bootstrap"]);
    expect(launchd.loadedText).toBe(plistWith());
  });

  it("unloads and loads with unload and load on older macOS", async () => {
    writePlist(v1Plist());
    launchd.loaded = true;
    launchd.bootoutFails = true;
    launchd.bootstrapFails = true;
    await daemonStart([], {});
    expect(launchctlCalls()).toEqual(["list", "print-disabled", "bootout", "unload", "list", "bootstrap", "load"]);
    // Not -w: that would switch back on a job the user switched off (engram#654).
    expect(loads()).toEqual([`load ${PLIST}`]);
    expect(launchd.loadedText).toBe(plistWith());
  });

  it("waits five seconds at most for launchd, and says why it couldn't load the job", () => {
    writePlist(plistWith());
    launchd.loaded = true;
    launchd.stillLoadedFor = Infinity;
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => (now += 1_000));
    try {
      expect(reloadAgent()).toBe("Load failed: 5: Input/output error");
    } finally {
      clock.mockRestore();
    }
    expect(launchctlCalls()).toEqual(["bootout", "list", "list", "list", "list", "list", "bootstrap", "load"]);
    expect(loads()).toEqual([`load ${PLIST}`]);
  });
});

describe("engram status on macOS (engram#616)", () => {
  it("says start at login is on", async () => {
    writePlist(plistWith());
    daemonRunning();
    await daemonStatus();
    const text = output();
    expect(text).toContain("Auto-start: enabled (launchd)");
    expect(text).not.toContain("outdated");
    expect(text).not.toContain("broken");
    expect(launchctlCalls()).toEqual(["print-disabled"]);
  });

  it("says a plist launchd can't start the daemon from is broken", async () => {
    for (const text of [
      plistWith({ worker: join(home.dir, "gone", "worker.js") }),
      plistWith({ node: join(home.dir, "gone", "node") }),
      plistWith({ home: "/Users/a<b" }).replace("&lt;", () => "<"),
    ]) {
      writePlist(text);
      daemonRunning();
      await daemonStatus();
      expect(said()).toContain("Auto-start: enabled (launchd)  — broken, run 'engram install' to repair");
    }
  });

  it("says an older plist is outdated", async () => {
    writePlist(v1Plist());
    daemonRunning();
    await daemonStatus();
    expect(output()).toContain("Auto-start: enabled (launchd)  — outdated config, run 'engram install' to update");
  });

  it("points at what repairs or updates it while the daemon runs: engram install (engram#651)", async () => {
    for (const text of [v1Plist(), plistWith({ node: join(home.dir, "gone", "node") })]) {
      writePlist(text);
      launchd.loaded = true;
      launchd.loadedText = text;
      daemonRunning();
      await daemonStatus();
      expect(said()).toMatch(/^Auto-start: enabled \(launchd\) {2}— (broken|outdated config), run 'engram install' to (repair|update)$/m);
      // engram start finds the daemon running, and repairs nothing.
      await daemonStart([], {});
      expect(readFileSync(PLIST, "utf-8")).toBe(text);
      expect(said()).toContain("Daemon already running");
      await daemonInstall();
      expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
      expect(launchd.loadedText).toBe(plistWith());
      expect(said()).toContain("Auto-start enabled — daemon will start on login");
      await daemonStatus();
      const after = said();
      expect(after).toContain("Auto-start: enabled (launchd)");
      expect(after).not.toMatch(/broken|outdated|engram start/);
    }
  });

  it("says nothing of start at login without a plist", async () => {
    daemonRunning();
    await daemonStatus();
    expect(output()).not.toContain("Auto-start");
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("says the daemon should be running when start at login is on and it isn't", async () => {
    writePlist(plistWith());
    await daemonStatus();
    expect(said()).toContain("It should be running: start at login is on.");

    // Not when start at login is broken: that is why, and status says so.
    writePlist(plistWith({ node: join(home.dir, "gone", "node") }));
    await daemonStatus();
    const text = said();
    expect(text).toContain("broken");
    expect(text).not.toContain("It should be running");
  });

  it("finds a daemon from before engram#612, which has no socket, through launchd", async () => {
    writePlist(plistWith());
    launchd.loaded = true;
    launchd.pid = 4242;
    await daemonStatus();
    const text = output();
    expect(text).toContain("Status: running (pid 4242)");
    expect(text).toContain("It's from an older version of Engram");
    expect(launchctlCalls()).toEqual(["list", "print-disabled"]);
  });

  it("names the daemon launchd runs when something holds the socket and doesn't answer", async () => {
    writePlist(plistWith());
    launchd.loaded = true;
    launchd.pid = 4242;
    daemon.silent = true;
    await daemonStatus();
    expect(output()).toContain("Status: running (pid 4242) — not answering right now");
    expect(launchctlCalls()).toEqual(["list", "print-disabled"]);
  });

  it("off macOS, never takes a plist older CLIs wrote for launchd's, or asks launchctl about it", async () => {
    // CLIs before engram#602 wrote one on every OS. A launchctl on PATH all the same.
    writePlist(plistWith());
    launchd.loaded = true;
    launchd.pid = 4242;
    vi.stubEnv("XDG_CONFIG_HOME", undefined);
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    await daemonStatus();
    const text = output();
    expect(text).toContain("Status: stopped");
    expect(text).not.toContain("launchd");
    expect(execFileSync).not.toHaveBeenCalled();
  });
});

describe("engram uninstall on macOS (engram#616)", () => {
  it("unloads the agent and removes the plist", async () => {
    writePlist(plistWith());
    launchd.loaded = true;
    await daemonUninstall();
    expect(existsSync(PLIST)).toBe(false);
    expect(launchd.loaded).toBe(false);
    expect(launchctlCalls()).toEqual(["bootout"]);
    expect(output()).toContain("Auto-start disabled — launchd agent removed");
    expect(process.exitCode).toBeUndefined();
  });

  it("removes one launchd hasn't loaded, and an older or broken one, just the same", async () => {
    for (const text of [plistWith(), v1Plist(), "<plist/>"]) {
      writePlist(text);
      execFileSync.mockClear();
      await daemonUninstall();
      expect(existsSync(PLIST)).toBe(false);
      expect(launchctlCalls()).toEqual(["bootout", "unload"]);
      expect(said()).toContain("Auto-start disabled");
    }
  });

  it("removes the plist with no launchctl to ask", async () => {
    writePlist(plistWith());
    vi.stubEnv("PATH", NO_BIN);
    await daemonUninstall();
    expect(existsSync(PLIST)).toBe(false);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(output()).toContain("Auto-start disabled");
  });

  it("says so when there is no plist", async () => {
    await daemonUninstall();
    expect(output()).toContain("Launchd agent not installed.");
    expect(execFileSync).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("fails, and says what to remove, when it can't remove the plist", async () => {
    // A directory in its place, which removing a file won't remove.
    mkdirSync(join(PLIST, "x"), { recursive: true });
    await daemonUninstall();
    expect(existsSync(PLIST)).toBe(true);
    const text = output();
    expect(text).toContain("Couldn't remove the launchd agent.");
    expect(text).toContain(`Remove ${PLIST} to turn start at login off.`);
    expect(text).not.toContain("Auto-start disabled");
    expect(process.exitCode).toBe(1);
  });
});

describe("auto-capture on macOS (engram#616)", () => {
  signedInAtATerminal();

  it("starts the daemon and turns on start at login after sign-in, then says nothing more", async () => {
    await autoEnableCapture({ after: "login" });
    expect(spawn).toHaveBeenCalledTimes(1);
    const text = said();
    expect(text).toContain("Auto-start enabled — daemon will start on login");
    expect(text).toContain("Auto-capture is on");
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
    expect(launchctlCalls()).toEqual(["print-disabled", "bootstrap"]);
    expect(launchd.loadedText).toBe(plistWith());

    execFileSync.mockClear();
    for (let command = 0; command < 3; command++) {
      await autoEnableCapture({ after: "command" });
      expect(said()).toBe("");
    }
    expect(execFileSync).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
  });

  it("turns on start at login after any other command, and says so", async () => {
    rmSync(LOG_FILE, { force: true });
    daemonRunning();
    await autoEnableCapture({ after: "command" });
    expect(spawn).not.toHaveBeenCalled();
    const text = said();
    expect(text).toContain("Auto-start enabled");
    expect(text).toContain("Auto-capture is on");
    expect(launchd.loaded).toBe(true);
    expect(launchd.logAtLoad).toBe(true);
  });

  it("updates an older plist of its own, says so once, then nothing", async () => {
    writePlist(v1Plist());
    launchd.loaded = true;
    daemonRunning();
    await autoEnableCapture({ after: "command" });
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
    expect(launchd.loadedText).toBe(plistWith());
    const text = said();
    expect(text).toContain("Updated auto-start configuration");
    expect(text).toContain("Auto-capture is on");

    await autoEnableCapture({ after: "command" });
    expect(said()).toBe("");
  });

  posixIt("says nothing after a command when a plist can't hold this home, and leaves the older one", async () => {
    const restore = homeNamed("new\nline");
    try {
      writePlist(v1Plist());
      daemonRunning();
      await autoEnableCapture({ after: "command" });
      expect(readFileSync(plistPath(), "utf-8")).toBe(v1Plist());
    } finally {
      restore();
    }
    expect(said()).toBe("");
    expect(execFileSync).not.toHaveBeenCalled();
  });

  permissionsIt("says nothing after a command when it can't write the update, and leaves the older one", async () => {
    writePlist(v1Plist());
    chmodSync(AGENTS, 0o555);
    try {
      daemonRunning();
      await autoEnableCapture({ after: "command" });
    } finally {
      chmodSync(AGENTS, 0o755);
    }
    expect(said()).toBe("");
    expect(readFileSync(PLIST, "utf-8")).toBe(v1Plist());
    expect(readdirSync(AGENTS)).toEqual([`${LABEL}.plist`]);
    expect(launchctlCalls()).toEqual(["print-disabled"]);
  });

  it("repairs a broken plist of its own", async () => {
    writePlist(plistWith({ home: "/Users/a<b" }).replace("&lt;", () => "<"));
    daemonRunning();
    await autoEnableCapture({ after: "command" });
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
    expect(said()).toContain("Updated auto-start configuration");
  });

  it("says it can't turn on start at login when it had to start the daemon, not after every command", async () => {
    // ~/Library/LaunchAgents a file: no plist can go there.
    mkdirSync(join(home.dir, "Library"), { recursive: true });
    writeFileSync(AGENTS, "");
    daemonRunning();
    await autoEnableCapture({ after: "command" });
    expect(said()).toBe("");

    daemonGone();
    await autoEnableCapture({ after: "command" });
    expect(spawn).toHaveBeenCalledTimes(1);
    // The worker itself: launchd is the one that starts it again.
    expect(spawn.mock.calls[0][1]).toEqual([expect.stringMatching(/[\\/]worker\.js$/)]);
    const text = said();
    expect(text).toContain("Couldn't turn on start at login. Run 'engram install' to try again.");
    expect(text).toContain("Auto-capture is on");
    expect(execFileSync).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  posixIt("says it couldn't turn on start at login when a plist can't hold this home", async () => {
    const restore = homeNamed("new\nline");
    try {
      await autoEnableCapture({ after: "login" });
    } finally {
      restore();
    }
    const text = said();
    expect(text).toContain("Couldn't turn on start at login. Run 'engram install' to try again.");
    expect(text).toContain("Auto-capture is on");
    expect(text).not.toContain("new\nline");
    expect(existsSync(join(home.dir, "new\nline", "Library"))).toBe(false);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("leaves start at login alone in a source checkout, which has no worker.js", async () => {
    rmSync(WORKER);
    daemonRunning();
    await autoEnableCapture({ after: "login" });
    expect(existsSync(join(home.dir, "Library"))).toBe(false);
    expect(execFileSync).not.toHaveBeenCalled();
    const text = said();
    expect(text).toContain("Auto-capture is on");
    expect(text).not.toContain("Auto-start");
    expect(text).not.toContain("start at login");
  });

  it("writes the plist when launchd won't load it now: launchd loads it at the next login", async () => {
    launchd.bootstrapFails = true;
    launchd.loadFails = true;
    daemonRunning();
    await autoEnableCapture({ after: "login" });
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
    expect(launchctlCalls()).toEqual(["print-disabled", "bootstrap", "load"]);
    expect(loads()).toEqual([`load ${PLIST}`]);
    const text = said();
    expect(text).toContain("Auto-start enabled");
    expect(text).toContain("Auto-capture is on");
  });
});

describe("launchd's switch for the job (engram#654)", () => {
  /** What print-disabled prints with these entries in its list. */
  const listed = (...entries: string[]) =>
    `\n\tdisabled services = {\n${entries.map((entry) => `\t\t${entry}\n`).join("")}\t}\n`;

  it("is read from launchctl print-disabled: switched off, switched on, or never switched", () => {
    expect(disabledIn(listed(`"${LABEL}" => disabled`))).toBe(true);
    expect(disabledIn(listed(`"${LABEL}" => enabled`))).toBe(false);
    // Older macOS: true for switched off, false for on.
    expect(disabledIn(listed(`"${LABEL}" => true`))).toBe(true);
    expect(disabledIn(listed(`"${LABEL}" => false`))).toBe(false);
    // Never switched: launchd loads it.
    expect(disabledIn(listed(`"com.example.agent" => disabled`))).toBe(false);
    expect(disabledIn(listed())).toBe(false);
    expect(disabledIn(listed(`"com.example.agent" => disabled`, `"${LABEL}" => disabled`))).toBe(true);
  });

  it("is the job's own, never another's whose label starts or ends with it", () => {
    for (const other of [`${LABEL}.helper`, `x.${LABEL}`, LABEL.toUpperCase(), ` ${LABEL}`, `${LABEL} `]) {
      expect(disabledIn(listed(`"${other}" => disabled`))).toBe(false);
    }
    // Nor in another list, or after the list.
    const elsewhere = `\tother services = {\n\t\t"${LABEL}" => disabled\n\t}\n`;
    expect(disabledIn(elsewhere)).toBeNull();
    expect(disabledIn(elsewhere + listed())).toBe(false);
    expect(disabledIn(listed() + elsewhere)).toBe(false);
    expect(disabledIn(`${listed()}"${LABEL}" => disabled\n`)).toBe(false);
  });

  it("is unknown from output it doesn't know", () => {
    for (const output of ["", "\n", `"${LABEL}" => disabled\n`, "disabled services = {\n"]) {
      // The last: a list it never saw the end of, which doesn't name the job.
      expect(disabledIn(output)).toBe(output.startsWith("disabled") ? false : null);
    }
    for (const value of ["off", "", "disabled!", "Disabled"]) {
      expect(disabledIn(listed(`"${LABEL}" => ${value}`))).toBeNull();
    }
  });

  it("is asked of the user's own launchd session, and is unknown when launchctl can't say", () => {
    expect(agentDisabled()).toBe(false);
    launchd.switchedOff = true;
    expect(agentDisabled()).toBe(true);
    launchd.switchedOff = false;
    expect(agentDisabled()).toBe(false);
    launchd.printDisabledFails = true;
    expect(agentDisabled()).toBeNull();
    launchd.printDisabledFails = false;
    launchd.disabledOutput = "something a later macOS prints\n";
    expect(agentDisabled()).toBeNull();
    vi.stubEnv("PATH", NO_BIN);
    expect(agentDisabled()).toBeNull();
    const asked = execFileSync.mock.calls.map(([, args]) => (args as string[]).join(" "));
    expect(asked).toEqual(Array(5).fill(`print-disabled ${DOMAIN}`));
  });
});

describe("a job switched off in launchd (engram#654)", () => {
  beforeEach(() => {
    // As `launchctl disable`, or System Settings' Login Items, would leave it.
    launchd.switchedOff = true;
  });

  it("engram start leaves its older or broken plist as it is, and the job launchd has", async () => {
    for (const text of [v1Plist(), plistWith({ node: join(home.dir, "gone", "node") }), "<plist/>"]) {
      writePlist(text);
      // Loaded before it was switched off: launchd keeps it until it is unloaded.
      launchd.loaded = true;
      launchd.loadedText = text;
      daemonGone();
      execFileSync.mockClear();
      await daemonStart([], {});
      expect(readFileSync(PLIST, "utf-8")).toBe(text);
      expect(launchctlCalls()).toEqual(["list", "print-disabled"]);
      expect(launchd.loadedText).toBe(text);
      expect(said()).not.toContain("Updated auto-start configuration");
    }
    expect(launchd.switchedOff).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(process.exitCode).toBeUndefined();
  });

  it("engram status says start at login is off, before whether the plist is broken or outdated", async () => {
    for (const text of [plistWith(), v1Plist(), plistWith({ node: join(home.dir, "gone", "node") })]) {
      writePlist(text);
      daemonRunning();
      execFileSync.mockClear();
      await daemonStatus();
      const status = said();
      expect(status).toContain("Auto-start: off — disabled in launchd  ('engram install' turns it back on)");
      expect(status).not.toContain("enabled (launchd)");
      expect(launchctlCalls()).toEqual(["print-disabled"]);
    }
    // Stopped, it isn't something that should be running.
    daemonGone();
    writePlist(plistWith());
    await daemonStatus();
    const text = said();
    expect(text).toContain("Status: stopped");
    expect(text).toContain("Auto-start: off — disabled in launchd");
    expect(text).not.toContain("It should be running");
  });

  it("engram status says start at login is on when launchctl can't say it's off", async () => {
    writePlist(plistWith());
    daemonRunning();
    for (const fails of [{ printDisabledFails: true }, { disabledOutput: "something a later macOS prints\n" }]) {
      Object.assign(launchd, fails);
      await daemonStatus();
      expect(said()).toContain("Auto-start: enabled (launchd)");
    }
  });

  it("engram install switches it back on, then loads it", async () => {
    await daemonInstall();
    expect(launchctlCalls()).toEqual(["print-disabled", "enable", "bootout", "unload", "list", "bootstrap"]);
    expect(execFileSync.mock.calls[1][1]).toEqual(["enable", `${DOMAIN}/${LABEL}`]);
    expect(loads()).toEqual([]);
    expect(launchd.switchedOff).toBe(false);
    expect(launchd.loadedText).toBe(plistWith());
    expect(output()).toContain("Auto-start enabled — daemon will start on login");
    expect(process.exitCode).toBeUndefined();
  });

  it("engram install switches one launchd has loaded back on, and leaves the daemon it runs", async () => {
    writePlist(plistWith());
    launchd.loaded = true;
    launchd.loadedText = plistWith();
    daemonRunning();
    await daemonInstall();
    expect(launchctlCalls()).toEqual(["print-disabled", "enable", "list"]);
    expect(launchd.switchedOff).toBe(false);
    expect(launchd.loaded).toBe(true);
    expect(output()).toContain("Auto-start enabled — daemon will start on login");
  });

  it("engram install switches it on with load -w where launchctl enable fails", async () => {
    launchd.enableFails = true;
    await daemonInstall();
    expect(launchctlCalls()).toEqual(["print-disabled", "enable", "bootout", "unload", "list", "bootstrap", "load"]);
    expect(loads()).toEqual([`load -w ${PLIST}`]);
    expect(launchd.switchedOff).toBe(false);
    expect(launchd.loaded).toBe(true);
    expect(output()).toContain("Auto-start enabled — daemon will start on login");

    // One launchd has loaded is loaded again, to switch it on.
    launchd.switchedOff = true;
    daemonRunning();
    execFileSync.mockClear();
    await daemonInstall();
    expect(launchctlCalls()).toEqual(["print-disabled", "enable", "bootout", "list", "bootstrap", "load"]);
    expect(launchd.switchedOff).toBe(false);
    expect(launchd.loaded).toBe(true);
  });

  it("engram install switches it on when launchctl can't say whether it's off", async () => {
    launchd.printDisabledFails = true;
    await daemonInstall();
    expect(launchctlCalls()).toEqual(["print-disabled", "enable", "bootout", "unload", "list", "bootstrap"]);
    expect(launchd.switchedOff).toBe(false);
    expect(launchd.loaded).toBe(true);
  });

  it("engram install doesn't switch on one that is on", async () => {
    launchd.switchedOff = false;
    await daemonInstall();
    expect(launchctlCalls()).toEqual(["print-disabled", "bootout", "unload", "list", "bootstrap"]);
    launchd.switchedOff = null;
    rmSync(join(home.dir, "Library"), { recursive: true, force: true });
    launchd.loaded = false;
    execFileSync.mockClear();
    await daemonInstall();
    expect(launchctlCalls()).toEqual(["print-disabled", "bootout", "unload", "list", "bootstrap"]);
  });

  it("engram start --install switches it back on too", async () => {
    daemonRunning();
    await daemonStart([], { install: "" });
    expect(spawn).not.toHaveBeenCalled();
    expect(launchctlCalls()).toEqual(["print-disabled", "enable", "bootout", "unload", "list", "bootstrap"]);
    expect(launchd.switchedOff).toBe(false);
    expect(launchd.loaded).toBe(true);
  });

  it("a repair when launchctl can't say leaves it off all the same: it loads without -w", async () => {
    launchd.printDisabledFails = true;
    writePlist(v1Plist());
    await daemonStart([], {});
    // Written, as for any older plist, and loaded at no login while it is off.
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
    expect(loads()).toEqual([`load ${PLIST}`]);
    expect(launchd.switchedOff).toBe(true);
    expect(launchd.loaded).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("engram uninstall leaves the switch as it is", async () => {
    for (const switchedOff of [true, false]) {
      launchd.switchedOff = switchedOff;
      writePlist(plistWith());
      execFileSync.mockClear();
      await daemonUninstall();
      expect(existsSync(PLIST)).toBe(false);
      expect(launchctlCalls()).toEqual(["bootout", "unload"]);
      expect(launchd.switchedOff).toBe(switchedOff);
      expect(said()).toContain("Auto-start disabled");
    }
  });

  describe("auto-capture", () => {
    signedInAtATerminal();

    it("leaves its older plist as it is after a command, and says nothing", async () => {
      writePlist(v1Plist());
      daemonRunning();
      await autoEnableCapture({ after: "command" });
      expect(said()).toBe("");
      expect(readFileSync(PLIST, "utf-8")).toBe(v1Plist());
      expect(launchctlCalls()).toEqual(["print-disabled"]);
      expect(launchd.switchedOff).toBe(true);
    });

    it("writes a plist where there is none, leaves it off, and says so once", async () => {
      // launchd keeps the switch after the plist is gone, as after `engram uninstall`.
      await autoEnableCapture({ after: "login" });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
      expect(launchctlCalls()).toEqual(["print-disabled"]);
      expect(launchd.loaded).toBe(false);
      expect(launchd.switchedOff).toBe(true);
      const text = said();
      expect(text).toContain("Start at login is switched off in launchd");
      expect(text).toContain("Run 'engram install' to start the daemon when you log in.");
      expect(text).toContain("Auto-capture is on");
      expect(text).not.toContain("Auto-start enabled");

      // Then nothing more: the plist is current, and launchctl isn't asked.
      execFileSync.mockClear();
      for (let command = 0; command < 3; command++) {
        await autoEnableCapture({ after: "command" });
        expect(said()).toBe("");
      }
      expect(execFileSync).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBeUndefined();
    });

    it("says so after any other command too, then nothing more", async () => {
      daemonRunning();
      await autoEnableCapture({ after: "command" });
      expect(spawn).not.toHaveBeenCalled();
      const text = said();
      expect(text).toContain("Start at login is switched off in launchd");
      expect(text).toContain("Auto-capture is on");
      expect(launchd.loaded).toBe(false);
      await autoEnableCapture({ after: "command" });
      expect(said()).toBe("");
    });

    it("loads it without -w when launchctl can't say whether it's off: one that is on loads, one that is off stays off", async () => {
      launchd.printDisabledFails = true;
      for (const switchedOff of [null, true]) {
        Object.assign(launchd, { switchedOff, loaded: false, loadedText: null });
        rmSync(join(home.dir, "Library"), { recursive: true, force: true });
        daemonRunning();
        execFileSync.mockClear();
        await autoEnableCapture({ after: "command" });
        expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
        expect(said()).toContain("Auto-start enabled");
        if (switchedOff === null) {
          expect(launchctlCalls()).toEqual(["print-disabled", "bootstrap"]);
          expect(launchd.loaded).toBe(true);
        } else {
          expect(launchctlCalls()).toEqual(["print-disabled", "bootstrap", "load"]);
          expect(loads()).toEqual([`load ${PLIST}`]);
          expect(launchd.switchedOff).toBe(true);
          expect(launchd.loaded).toBe(false);
        }
      }
    });
  });
});

describe("a CLI and a Node installed with brew (engram#652)", () => {
  // A Homebrew prefix as `brew install node engram` leaves one: each version
  // in its keg under Cellar/, and opt/<formula> a link to the current one.
  // Homebrew's Node gives its keg as process.execPath, and a CLI installed
  // with brew runs from its own: the next `brew upgrade` removes both.
  // Links: Windows makes them only with a privilege.
  const BREW = join(realpathSync.native(home.dir), "brew");
  const IN_KEG = ["libexec", "lib", "node_modules", "@getengram", "cli", "dist", "daemon", "worker.js"];
  const KEG = {
    node: join(BREW, "Cellar", "node", "25.1.0", "bin", "node"),
    worker: join(BREW, "Cellar", "engram", "0.7.0", ...IN_KEG),
  };
  /** A version brew keeps until its cleanup, which opt/node no longer leads to. */
  const OLDER_NODE = join(BREW, "Cellar", "node", "25.0.0", "bin", "node");
  const OPT = {
    node: join(BREW, "opt", "node", "bin", "node"),
    worker: join(BREW, "opt", "engram", ...IN_KEG),
  };
  /** The plist the CLI brew installed writes: Node and the worker through the opt links. */
  const THROUGH_OPT: Partial<PlistPaths> = {
    ...OPT,
    path: `${dirname(OPT.node)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
  /** The one the same CLI wrote before engram#652: the kegs themselves. */
  const IN_KEGS: Partial<PlistPaths> = {
    ...KEG,
    path: `${dirname(KEG.node)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  };

  beforeAll(() => {
    if (HOST === "win32") return;
    for (const file of [KEG.node, KEG.worker, OLDER_NODE]) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "");
    }
    mkdirSync(join(BREW, "opt"));
    symlinkSync("../Cellar/node/25.1.0", join(BREW, "opt", "node"));
    symlinkSync("../Cellar/engram/0.7.0", join(BREW, "opt", "engram"));
  });

  /** Run as the CLI brew installed does: on Homebrew's Node, with this build in its keg. */
  async function asBrewCli(run: () => unknown, node = KEG.node): Promise<void> {
    const execPath = process.execPath;
    process.execPath = node;
    cli.worker = KEG.worker;
    try {
      await run();
    } finally {
      process.execPath = execPath;
      cli.worker = null;
    }
  }

  posixIt("engram install names Node and the worker through the opt links, which outlast the next upgrade", async () => {
    await asBrewCli(() => daemonInstall());
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith(THROUGH_OPT));
    expect(launchd.loadedText).toBe(plistWith(THROUGH_OPT));
    expect(readPlist()).toEqual({ kind: "ours", broken: false, version: PLIST_VERSION, outdated: false });
    expect(said()).toContain("Auto-start enabled — daemon will start on login");
    expect(process.exitCode).toBeUndefined();
  });

  posixIt("finds a plist naming either keg outdated, not broken: it works only until the next upgrade", () => {
    for (const pinned of [IN_KEGS, { node: KEG.node }, { worker: KEG.worker }]) {
      writePlist(plistWith(pinned));
      expect(readPlist()).toEqual({ kind: "ours", broken: false, version: PLIST_VERSION, outdated: true });
    }
    writePlist(plistWith(THROUGH_OPT));
    expect(readPlist()).toEqual({ kind: "ours", broken: false, version: PLIST_VERSION, outdated: false });
  });

  posixIt("finds one naming a version the upgrade removed broken, as before; leaves a newer CLI's to it", () => {
    writePlist(plistWith({ node: join(BREW, "Cellar", "node", "24.0.0", "bin", "node") }));
    expect(readPlist()).toEqual({ kind: "ours", broken: true, version: PLIST_VERSION, outdated: false });
    writePlist(plistWith(IN_KEGS, PLIST_VERSION + 1));
    expect(readPlist()).toEqual({ kind: "ours", broken: false, version: PLIST_VERSION + 1, outdated: false });
  });

  posixIt("engram status says one naming the kegs is outdated, until engram install rewrites it", async () => {
    writePlist(plistWith(IN_KEGS));
    daemonRunning();
    await daemonStatus();
    expect(said()).toContain("Auto-start: enabled (launchd)  — outdated config, run 'engram install' to update");
    await asBrewCli(() => daemonInstall());
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith(THROUGH_OPT));
    said();
    await daemonStatus();
    const after = said();
    expect(after).toContain("Auto-start: enabled (launchd)");
    expect(after).not.toMatch(/broken|outdated/);
  });

  posixIt("engram start rewrites one naming the kegs, once, and launchd loads it in its place", async () => {
    writePlist(plistWith(IN_KEGS));
    launchd.loaded = true;
    launchd.loadedText = plistWith(IN_KEGS);
    await asBrewCli(() => daemonStart([], {}));
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith(THROUGH_OPT));
    expect(launchd.loadedText).toBe(plistWith(THROUGH_OPT));
    expect(launchctlCalls()).toEqual(["list", "print-disabled", "bootout", "list", "bootstrap"]);
    expect(said()).toContain(`Updated auto-start configuration (plist v${PLIST_VERSION})`);
    expect(spawn).toHaveBeenCalledTimes(1);

    // Current from then on.
    daemonGone();
    execFileSync.mockClear();
    await asBrewCli(() => daemonStart([], {}));
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith(THROUGH_OPT));
    expect(launchctlCalls()).toEqual(["list"]);
    expect(said()).not.toContain("Updated auto-start configuration");
    expect(process.exitCode).toBeUndefined();
  });

  posixIt("engram start from a CLI brew didn't install points the plist at that CLI, as with an older plist", async () => {
    writePlist(plistWith(IN_KEGS));
    await daemonStart([], {});
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
    expect(said()).toContain("Updated auto-start configuration");
  });

  posixIt("names a Node version opt/node no longer leads to as it is, and leaves that plist be", async () => {
    const ownPath: Partial<PlistPaths> = {
      node: OLDER_NODE,
      worker: OPT.worker,
      path: `${dirname(OLDER_NODE)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    };
    await asBrewCli(() => daemonInstall(), OLDER_NODE);
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith(ownPath));
    expect(readPlist()).toEqual({ kind: "ours", broken: false, version: PLIST_VERSION, outdated: false });
    // Never rewritten again and again: what it writes reads as current.
    daemonGone();
    said();
    await asBrewCli(() => daemonStart([], {}), OLDER_NODE);
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith(ownPath));
    expect(said()).not.toContain("Updated auto-start configuration");
  });

  describe("auto-capture", () => {
    signedInAtATerminal();

    posixIt("rewrites one naming the kegs after a command, says so once, then nothing", async () => {
      writePlist(plistWith(IN_KEGS));
      launchd.loaded = true;
      launchd.loadedText = plistWith(IN_KEGS);
      daemonRunning();
      await asBrewCli(() => autoEnableCapture({ after: "command" }));
      expect(readFileSync(PLIST, "utf-8")).toBe(plistWith(THROUGH_OPT));
      expect(launchd.loadedText).toBe(plistWith(THROUGH_OPT));
      const text = said();
      expect(text).toContain("Updated auto-start configuration");
      expect(text).toContain("Auto-capture is on");

      execFileSync.mockClear();
      for (let command = 0; command < 3; command++) {
        await asBrewCli(() => autoEnableCapture({ after: "command" }));
        expect(said()).toBe("");
      }
      expect(execFileSync).not.toHaveBeenCalled();
      expect(readFileSync(PLIST, "utf-8")).toBe(plistWith(THROUGH_OPT));
    });
  });
});

describe("the plist, as macOS reads it (engram#616)", () => {
  // Read-only: plutil on files in the test's own temp home. launchd itself
  // reads plists through libxpc, which reads what generatePlist() writes
  // back the same (checked by hand: see the PR for engram#616).
  macIt("is one plutil reads, with every path in it as it is", async () => {
    const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const dir = join(home.dir, "plutil");
    mkdirSync(dir, { recursive: true });
    for (const [i, odd] of [
      "/Users/A&B",
      "/Users/a<b>c",
      `/Users/"double" 'single'`,
      "/Users/&amp;",
      "/Users/x]]>y",
      "/Users/Jürgen 😀",
    ].entries()) {
      const paths: PlistPaths = { ...THIS_CLI, home: odd, path: `${odd}/bin:/usr/bin:/bin` };
      const file = join(dir, `${i}.plist`);
      writeFileSync(file, generatePlist(paths));
      real.execFileSync("/usr/bin/plutil", ["-lint", "-s", file], { stdio: "pipe" });
      const read = JSON.parse(
        real.execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf-8", stdio: "pipe" }),
      );
      expect(read).toEqual({
        Label: LABEL,
        ProgramArguments: [paths.node, paths.worker],
        RunAtLoad: true,
        KeepAlive: { SuccessfulExit: false },
        StandardOutPath: paths.log,
        StandardErrorPath: paths.log,
        ThrottleInterval: 10,
        EnvironmentVariables: { HOME: odd, PATH: paths.path, ENGRAM_PLIST_VERSION: String(PLIST_VERSION) },
      });
    }
  });
});
