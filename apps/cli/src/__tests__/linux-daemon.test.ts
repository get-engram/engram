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
import type { UnitPaths } from "../daemon/systemd.js";

/**
 * engram#615 — start at login on Linux: a systemd user unit,
 * $XDG_CONFIG_HOME/systemd/user/engram.service, enabled into default.target.
 *
 * These run the Linux code paths on any OS: process.platform is switched to
 * linux, systemctl is a fake that makes and removes the enable link as the
 * real one does, XDG_CONFIG_HOME and the home directory are temp dirs, and
 * nothing reaches a real systemd, ~/.config or ~/.engram. The real systemd
 * runs in CI, in scripts/e2e-systemd.mjs.
 */

const { home, cli, daemon, systemd, spawn, execSync, execFileSync } = vi.hoisted(() => ({
  home: { dir: "" },
  // This build's worker, when it isn't the one in the test's home: a CLI
  // installed with brew runs from a versioned keg (engram#652).
  cli: { worker: null as string | null },
  // What answers on the daemon's socket: a daemon, or nothing.
  daemon: { answering: null as { pid: number; stopping?: boolean; version?: string } | null },
  // The fake user service manager: whether it answers, and whether it
  // refuses to enable the unit. The daemon it runs for the unit (MainPID, 0
  // for none) and the last one it started (ExecMainPID), what it says when
  // it refuses to start the unit, and what a start does: start a daemon
  // that answers, ready; one that exits as it starts; or nothing.
  systemd: {
    reachable: true,
    enableFails: false,
    mainPid: 0,
    execMainPid: 0,
    startRefusal: null as string | null,
    starts: "daemon" as "daemon" | "dies" | "never",
    // It answers `show` without the PID asked for: none to go by.
    pidUnreadable: false,
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
    const a = daemon.answering;
    if (a === null) return { state: "none", stale: false };
    return { state: "answered", info: { ready: true, stopping: false, stopFile: false, vaultKeyReread: true, version: real.VERSION, ...a } };
  };
  return { ...real, probeDaemon };
});

/** What the test setup gave this file, before any test stubs it. */
const SETUP_CONFIG_HOME = process.env.XDG_CONFIG_HOME;

/** The OS this runs on: the tests say linux, whatever it is. */
const HOST = process.platform;
const posixIt = HOST === "win32" ? it.skip : it;
/** For a test of file permissions, which root and Windows don't keep to. */
const permissionsIt = HOST === "win32" || process.getuid?.() === 0 ? it.skip : it;

home.dir = mkdtempSync(join(tmpdir(), "engram-615-"));
const CONFIG = join(home.dir, "config");
const UNIT_DIR = join(CONFIG, "systemd", "user");
const UNIT = join(UNIT_DIR, "engram.service");
const WANTS = join(UNIT_DIR, "default.target.wants", "engram.service");
const BIN = join(home.dir, "bin");
const NO_BIN = join(home.dir, "no-bin");
const SYSTEMCTL = join(BIN, "systemctl");
const ENGRAM_DIR = join(home.dir, ".engram");
const PID_FILE = join(ENGRAM_DIR, "daemon.pid");
const WORKER = join(home.dir, "cli", "dist", "daemon", "worker.js");

/** Where CLIs before engram#602 wrote a launchd plist, off macOS too. */
const STRAY_PLIST = join(home.dir, "Library", "LaunchAgents", "app.getengram.daemon.plist");
mkdirSync(dirname(WORKER), { recursive: true });
mkdirSync(BIN);
mkdirSync(NO_BIN);
// Never run: execFileSync is the fake below. It is there to be found on PATH.
writeFileSync(SYSTEMCTL, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

const { LOG_FILE } = await import("../daemon/launch.js");
const { loadConfigStrict } = await import("../config.js");
const {
  autoEnableCapture,
  daemonInstall,
  daemonStart,
  daemonStatus,
  daemonUninstall,
  repairSystemdUnitIfStale,
  waitForAgent,
} = await import("../daemon/commands.js");
const {
  UNIT_VERSION,
  execWord,
  execWords,
  generateUnit,
  readUnit,
  rewriteUnit,
  systemctlPath,
  unitPath,
} = await import("../daemon/systemd.js");
const { throughOptLink } = await import("../daemon/homebrew.js");

/** Node as start at login names it: through Homebrew's opt link, when it runs from a keg (engram#652). */
const NODE = throughOptLink(realpathSync.native(process.execPath));
/** The unit's paths for this CLI, as `engram install` writes them. */
const THIS_CLI: UnitPaths = {
  node: NODE,
  worker: WORKER,
  log: LOG_FILE,
  engramDir: ENGRAM_DIR,
  home: home.dir,
  path: `${dirname(NODE)}:/usr/local/bin:/usr/bin:/bin`,
};

/** A unit of ours, for these paths and this version. */
function unitWith(paths: Partial<UnitPaths> = {}, version = UNIT_VERSION): string {
  const text = generateUnit({ ...THIS_CLI, ...paths });
  return text.replace(`ENGRAM_UNIT_VERSION=${UNIT_VERSION}\n`, `ENGRAM_UNIT_VERSION=${version}\n`);
}

/** Put `text` where the unit goes; enabled, it has the link `systemctl enable` makes. */
function writeUnit(text: string, enabled = true): void {
  mkdirSync(UNIT_DIR, { recursive: true });
  writeFileSync(UNIT, text);
  if (enabled) link();
}

/** The link `enable` makes: a symlink, as systemctl makes it, where this OS lets a test make one. */
function link(): void {
  mkdirSync(dirname(WANTS), { recursive: true });
  rmSync(WANTS, { force: true });
  if (HOST === "win32") writeFileSync(WANTS, "");
  else symlinkSync(UNIT, WANTS);
}

function linked(): boolean {
  try {
    lstatSync(WANTS);
    return true;
  } catch {
    return false;
  }
}

function failed(command: string, stderr: string): Error {
  return Object.assign(new Error(`Command failed: ${command}`), { status: 1, stderr });
}

/** systemctl --user, against the files above: what the real one does to them. */
function fakeSystemctl(file: string, args: string[]): string {
  if (file !== SYSTEMCTL) throw new Error(`unexpected program ${file}`);
  if (args[0] !== "--user") throw new Error(`systemctl without --user: ${args.join(" ")}`);
  const command = args.slice(1).join(" ");
  if (!systemd.reachable) throw failed(command, "Failed to connect to bus: No medium found\n");
  switch (command) {
    case "show --property=Version":
      return "Version=255\n";
    case "daemon-reload":
      return "";
    case "enable engram.service":
      // Its first line blank, as systemctl's stderr can start.
      if (systemd.enableFails) throw failed(command, "\nFailed to enable unit: Access denied\n");
      if (!existsSync(UNIT)) throw failed(command, "Failed to enable unit: Unit file engram.service does not exist.\n");
      link();
      return "";
    case "disable engram.service":
      rmSync(WANTS, { force: true });
      return "";
    case "start engram.service":
      // Never a start of a unit the CLI would have spawned the daemon beside.
      if (!existsSync(UNIT) || !linked()) throw new Error("a start of a unit that isn't enabled");
      if (systemd.startRefusal !== null) throw failed(command, systemd.startRefusal);
      if (systemd.mainPid !== 0) return ""; // it runs: left as it is
      if (systemd.starts === "daemon") systemdRunsDaemon();
      // Gone as it started: systemd names it until the next.
      if (systemd.starts === "dies") systemd.execMainPid = DEAD_PID;
      return "";
    case "show engram.service --property=MainPID":
      return systemd.pidUnreadable ? "" : `MainPID=${systemd.mainPid}\n`;
    case "show engram.service --property=ExecMainPID":
      return systemd.pidUnreadable ? "" : `ExecMainPID=${systemd.execMainPid}\n`;
    default:
      throw new Error(`unexpected systemctl ${command}`);
  }
}

/** A PID no process has: fakeKill finds only this process, and those made up, alive. */
const DEAD_PID = 999_999;

/** Made-up processes, beside this one, that signal 0 finds alive: a daemon that is stopping. */
const madeUp = new Set<number>();
/** Timers a test set; cleared after it. */
const timers: NodeJS.Timeout[] = [];

/** `engram install` turning start at login on: whether a user service manager answers, then the unit, enabled. */
const ENABLE = ["show --property=Version", "daemon-reload", "enable engram.service"];
/**
 * A start through systemd (engram#689): whether the user service manager
 * answers, the start, and the PID it gave the daemon.
 */
const THROUGH_SYSTEMD = ["show --property=Version", "start engram.service", "show engram.service --property=ExecMainPID"];

/** What a start says when systemctl refused to start the unit with `refusal`. */
const startedDirectly = (refusal: string) =>
  `systemd couldn't start the daemon (systemctl: ${refusal}), so it is started directly, and won't be restarted after a crash.`;

/** Said when the daemon runs, and systemd could run it but doesn't (engram#689). */
const OUTSIDE_SYSTEMD = `The running daemon (pid ${process.pid}) wasn't started by systemd, so systemd won't restart it after a crash: run 'engram stop' and then 'engram start' to fix that.`;

/** The fake manager's calls, without the --user every one has. */
function systemctlCalls(): string[] {
  return execFileSync.mock.calls.map(([, args]) => (args as string[]).slice(1).join(" "));
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

/** The daemon runs, and systemd started it: the unit's main process (engram#689). */
function systemdRunsDaemon(): void {
  daemonRunning();
  systemd.mainPid = systemd.execMainPid = process.pid;
}

/** The daemon is gone, as after a restart, and systemd runs none. */
function daemonGone(): void {
  daemon.answering = null;
  systemd.mainPid = 0;
  rmSync(PID_FILE, { force: true });
}

/** A made-up PID: the daemon systemd runs, stopping. */
const STOPPING = 4_243;

/**
 * systemd's daemon is stopping, as `engram stop` leaves it while a send
 * finishes: it answers that it is stopping, and exits `exitsIn` ms from now,
 * or never. Then nothing answers, and systemd runs none: the daemon exited
 * 0, which Restart=on-failure doesn't start again.
 */
function daemonStopping(exitsIn?: number): void {
  systemd.mainPid = systemd.execMainPid = STOPPING;
  madeUp.add(STOPPING);
  daemon.answering = { pid: STOPPING, stopping: true };
  if (exitsIn === undefined) return;
  timers.push(
    setTimeout(() => {
      madeUp.delete(STOPPING);
      daemonGone();
    }, exitsIn),
  );
}

/**
 * A home with a newline in its name, which a unit can't hold, with this
 * build's worker in it. Gives back what puts the home back.
 */
function homeWithNewline(): () => void {
  const dir = home.dir;
  home.dir = join(dir, "new\nline");
  const worker = join(home.dir, "cli", "dist", "daemon", "worker.js");
  mkdirSync(dirname(worker), { recursive: true });
  writeFileSync(worker, "");
  return () => {
    home.dir = dir;
  };
}

/**
 * Signal 0 finds this process, and those made up, alive; any other signal
 * fails the test before it reaches a process.
 */
function fakeKill(pid: number, signal: string | number = "SIGTERM"): true {
  if (signal === 0 && (pid === process.pid || madeUp.has(pid))) return true;
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

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  systemd.reachable = true;
  systemd.enableFails = false;
  systemd.mainPid = 0;
  systemd.execMainPid = 0;
  systemd.startRefusal = null;
  systemd.starts = "daemon";
  systemd.pidUnreadable = false;
  daemon.answering = null;
  madeUp.clear();
  cli.worker = null;
  rmSync(CONFIG, { recursive: true, force: true });
  rmSync(PID_FILE, { force: true });
  writeFileSync(WORKER, "");
  vi.stubEnv("XDG_CONFIG_HOME", CONFIG);
  vi.stubEnv("PATH", BIN);
  spawn.mockReset().mockImplementation(fakeSpawn);
  execSync.mockReset();
  execFileSync.mockReset().mockImplementation(fakeSystemctl);
  vi.spyOn(process, "kill").mockImplementation(fakeKill);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const timer of timers.splice(0)) clearTimeout(timer);
  Object.defineProperty(process, "platform", { value: HOST, configurable: true });
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(() => rmSync(home.dir, { recursive: true, force: true }));

describe("the tests' own config directory (engram#615)", () => {
  it("is a temporary one in every test file, never the real ~/.config", () => {
    expect(SETUP_CONFIG_HOME).toBeDefined();
    expect(realpathSync(dirname(SETUP_CONFIG_HOME!))).toBe(realpathSync(tmpdir()));
    expect(SETUP_CONFIG_HOME).toContain("engram-test-config-");
  });
});

describe("the unit (engram#615)", () => {
  const paths: UnitPaths = {
    node: "/usr/lib/node/bin/node",
    worker: "/usr/lib/node_modules/@getengram/cli/dist/daemon/worker.js",
    log: "/home/op/.engram/daemon.log",
    engramDir: "/home/op/.engram",
    home: "/home/op",
    path: "/usr/lib/node/bin:/usr/local/bin:/usr/bin:/bin",
  };

  it("is what systemd is given", () => {
    expect(generateUnit(paths)).toBe(`# Engram: starts the capture daemon when you log in.
# Written by 'engram install'; 'engram uninstall' removes it. The CLI may
# rewrite this file: for changes of your own, use 'systemctl --user edit engram'.
[Unit]
Description=Engram capture daemon
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
ExecStart=/bin/sh -c '( umask 077; mkdir -p -- "$$4" && : >>"$$3" ) 2>/dev/null; exec "$$1" "$$2" >>"$$3" 2>&1' engram "/usr/lib/node/bin/node" "/usr/lib/node_modules/@getengram/cli/dist/daemon/worker.js" "/home/op/.engram/daemon.log" "/home/op/.engram"
Restart=on-failure
RestartSec=10
Environment="HOME=/home/op"
Environment="PATH=/usr/lib/node/bin:/usr/local/bin:/usr/bin:/bin"
Environment=ENGRAM_UNIT_VERSION=1

[Install]
WantedBy=default.target
`);
  });

  it("gives every path back as it is, whatever is in it", () => {
    const odd = `/home/O'Brien "Q" \\ $HOME %h ü`;
    const unit = generateUnit({
      ...paths,
      node: `${odd}/node`,
      worker: `${odd}/worker.js`,
      log: `${odd}/.engram/daemon.log`,
      engramDir: `${odd}/.engram`,
      home: odd,
    });
    const exec = /^ExecStart=(.*)$/m.exec(unit)![1];
    expect(execWords(exec)).toEqual([
      "/bin/sh",
      "-c",
      `( umask 077; mkdir -p -- "$4" && : >>"$3" ) 2>/dev/null; exec "$1" "$2" >>"$3" 2>&1`,
      "engram",
      `${odd}/node`,
      `${odd}/worker.js`,
      `${odd}/.engram/daemon.log`,
      `${odd}/.engram`,
    ]);
    // In Environment=, `$` is plain and `%` a specifier.
    expect(unit).toContain(`Environment="HOME=/home/O'Brien \\"Q\\" \\\\ $HOME %%h ü"\n`);
  });

  it("escapes one word of ExecStart for systemd", () => {
    expect(execWord(`a"b\\c%d$e`)).toBe(`"a\\"b\\\\c%%d$$e"`);
  });

  it("refuses a path with a control character in it", () => {
    for (const bad of ["/home/a\nb", "/home/a\tb", "/home/a\rb", "/home/a\x7fb", "/home/a\x00b"]) {
      expect(() => execWord(bad)).toThrow(/control character/);
      expect(() => generateUnit({ ...paths, home: bad })).toThrow(/control character/);
      expect(() => generateUnit({ ...paths, worker: bad })).toThrow(/control character/);
    }
  });

  it("is put in place whole or not at all, and a write that fails leaves nothing behind", () => {
    // A directory where the unit goes: the temporary file is written, and
    // can't be renamed over it.
    mkdirSync(UNIT, { recursive: true });
    expect(rewriteUnit(unitWith())).toBe(false);
    expect(readdirSync(UNIT_DIR)).toEqual(["engram.service"]);
    expect(statSync(UNIT).isDirectory()).toBe(true);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("reads back nothing it wouldn't write", () => {
    expect(execWords(`"/bin/node`)).toBeNull(); // never closed
    expect(execWords(`"/bin/%h/node"`)).toBeNull(); // a specifier
    expect(execWords(`"/bin/$HOME/node"`)).toBeNull(); // a variable
    expect(execWords(`"/bin/\\nnode"`)).toBeNull(); // a C escape
    expect(execWords(`"/a""/b"`)).toBeNull(); // a quote that doesn't end the word
    expect(execWords(`/bin/sh -c 'x y'  "z"`)).toEqual(["/bin/sh", "-c", "x y", "z"]);
    expect(execWords(`'%%' "$$" \\\\`)).toEqual(["%", "$", "\\"]);
  });
});

describe("where the unit goes (engram#615)", () => {
  it("is $XDG_CONFIG_HOME/systemd/user, else ~/.config/systemd/user, as systemd reads them", () => {
    expect(unitPath()).toBe(UNIT);
    // The XDG spec has a relative path ignored, as if it weren't set.
    for (const notAbsolute of [undefined, "", "relative/config"]) {
      vi.stubEnv("XDG_CONFIG_HOME", notAbsolute);
      expect(unitPath()).toBe(join(home.dir, ".config", "systemd", "user", "engram.service"));
    }
  });
});

describe("systemctl (engram#615)", () => {
  it("is found on PATH", () => {
    vi.stubEnv("PATH", [NO_BIN, BIN].join(delimiter));
    expect(systemctlPath()).toBe(SYSTEMCTL);
    vi.stubEnv("PATH", NO_BIN);
    expect(systemctlPath()).toBeNull();
    vi.stubEnv("PATH", undefined);
    expect(systemctlPath()).toBeNull();
  });

  it("is never found through a relative directory on PATH", () => {
    // Relative to the working directory, this one is BIN.
    const rel = relative(process.cwd(), BIN);
    vi.stubEnv("PATH", rel);
    // Where the temp dir is on another drive, there is no relative path to it.
    expect(systemctlPath()).toBe(isAbsolute(rel) ? SYSTEMCTL : null);
  });

  posixIt("is a file that can be run", () => {
    const dir = join(home.dir, "other-bin");
    mkdirSync(join(dir, "systemctl"), { recursive: true }); // a directory
    const notRunnable = join(home.dir, "plain-bin");
    mkdirSync(notRunnable, { recursive: true });
    writeFileSync(join(notRunnable, "systemctl"), "", { mode: 0o644 });
    vi.stubEnv("PATH", [dir, notRunnable, BIN].join(delimiter));
    expect(systemctlPath()).toBe(SYSTEMCTL);
  });
});

describe("engram install on Linux (engram#615)", () => {
  it("writes the unit, enables it, and has systemd start the daemon now (engram#689)", async () => {
    await daemonInstall();
    expect(readFileSync(UNIT, "utf-8")).toBe(unitWith());
    expect(readdirSync(UNIT_DIR).sort()).toEqual(["default.target.wants", "engram.service"]);
    expect(linked()).toBe(true);
    // Enabled, which starts it from the next login on; and started by
    // systemd now, which starts it again after a crash.
    expect(systemctlCalls()).toEqual([...ENABLE, ...THROUGH_SYSTEMD]);
    expect(spawn).not.toHaveBeenCalled();
    expect(systemd.mainPid).toBe(process.pid);
    const text = output();
    const enabled = text.indexOf("Auto-start enabled — daemon will start when you log in (systemd)");
    expect(enabled).toBeGreaterThanOrEqual(0);
    expect(text).toContain(`Unit: ${UNIT}`);
    expect(text.indexOf(`Engram daemon started (pid ${process.pid})`)).toBeGreaterThan(enabled);
    expect(text).not.toContain("started directly");
    expect(process.exitCode).toBeUndefined();
    expect(readUnit()).toEqual({ kind: "ours", enabled: true, broken: false, version: UNIT_VERSION, outdated: false });
  });

  posixIt("writes it 0644 whatever the umask, as systemd expects of a unit", async () => {
    const umask = process.umask(0o077);
    try {
      await daemonInstall();
    } finally {
      process.umask(umask);
    }
    expect(statSync(UNIT).mode & 0o777).toBe(0o644);
  });

  it("leaves a running daemon be, and says systemd won't restart one it didn't start (engram#689)", async () => {
    daemonRunning();
    await daemonInstall();
    expect(spawn).not.toHaveBeenCalled();
    // Then which daemon systemd runs: none.
    expect(systemctlCalls()).toEqual([...ENABLE, "show engram.service --property=MainPID"]);
    expect(linked()).toBe(true);
    expect(output()).toContain(OUTSIDE_SYSTEMD);
    expect(process.exitCode).toBeUndefined();
  });

  it("waits for a daemon that is stopping, as engram start does, then has systemd start one (engram#689)", async () => {
    // systemd's start finds the unit running while its daemon stops, and
    // starts none in its place.
    daemonStopping(300);
    await daemonInstall();
    const text = output();
    expect(text).toContain(`Waiting for the daemon that is stopping (pid ${STOPPING}) to finish...`);
    // Nothing asked of systemd while it waits.
    expect(systemctlCalls()).toEqual([...ENABLE, ...THROUGH_SYSTEMD]);
    expect(linked()).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
    expect(systemd.mainPid).toBe(process.pid);
    expect(existsSync(join(home.dir, "Library"))).toBe(false);
    expect(text).toContain(`Engram daemon started (pid ${process.pid})`);
    expect(process.exitCode).toBeUndefined();
  });

  it("turns start at login on, starts nothing and fails when the daemon stopping hasn't gone in time", async () => {
    daemonStopping();
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => (now += 5_000));
    try {
      await daemonInstall();
    } finally {
      clock.mockRestore();
    }
    // Enabled; no start.
    expect(systemctlCalls()).toEqual(ENABLE);
    expect(linked()).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
    expect(systemd.mainPid).toBe(STOPPING);
    const text = output();
    expect(text).toContain(`Waiting for the daemon that is stopping (pid ${STOPPING}) to finish...`);
    expect(text).toContain("Auto-start enabled — daemon will start when you log in (systemd)");
    expect(text).toContain(`The daemon is still stopping (pid ${STOPPING}). Run 'engram start' in a moment.`);
    expect(text).not.toContain("Engram daemon started");
    expect(process.exitCode).toBe(1);
  });

  it("turns a unit of its own back on, written as this CLI writes it", async () => {
    writeUnit(unitWith({ node: join(home.dir, "gone", "node") }, 0), false);
    daemonRunning();
    await daemonInstall();
    expect(readFileSync(UNIT, "utf-8")).toBe(unitWith());
    expect(linked()).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("refuses a unit it didn't write, and touches nothing", async () => {
    const theirs = "[Service]\nExecStart=/usr/bin/something-else\n";
    writeUnit(theirs, false);
    await daemonInstall();
    expect(readFileSync(UNIT, "utf-8")).toBe(theirs);
    expect(linked()).toBe(false);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    const text = output();
    expect(text).toContain(`Can't turn on start at login: ${UNIT} is there already, and Engram didn't write it.`);
    expect(text).toContain("Rename or remove it, then run 'engram install' again.");
    expect(process.exitCode).toBe(1);
  });

  it("takes a unit whose marker line is commented out for one it didn't write", async () => {
    const theirs = unitWith({}, 0).replace(/^Environment=ENGRAM_UNIT_VERSION=/m, "# Environment=ENGRAM_UNIT_VERSION=");
    writeUnit(theirs, false);
    expect(readUnit()).toEqual({ kind: "foreign" });
    await daemonInstall();
    expect(readFileSync(UNIT, "utf-8")).toBe(theirs);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  permissionsIt("refuses a unit it can't read, and touches nothing", async () => {
    const old = unitWith({}, 0);
    writeUnit(old, false);
    chmodSync(UNIT, 0o000);
    try {
      expect(readUnit()).toEqual({ kind: "foreign" });
      await daemonInstall();
      expect(execFileSync).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(linked()).toBe(false);
      expect(process.exitCode).toBe(1);
    } finally {
      chmodSync(UNIT, 0o644);
    }
    expect(readFileSync(UNIT, "utf-8")).toBe(old);
  });

  it("removes the plist an older CLI wrote here", async () => {
    mkdirSync(dirname(STRAY_PLIST), { recursive: true });
    writeFileSync(STRAY_PLIST, "<plist/>");
    try {
      await daemonInstall();
      expect(existsSync(STRAY_PLIST)).toBe(false);
      expect(linked()).toBe(true);
    } finally {
      rmSync(join(home.dir, "Library"), { recursive: true, force: true });
    }
  });

  posixIt("refuses a link in the unit's place, even to a unit of its own", async () => {
    const elsewhere = join(home.dir, "dotfiles", "engram.service");
    mkdirSync(dirname(elsewhere), { recursive: true });
    writeFileSync(elsewhere, unitWith({}, 0));
    mkdirSync(UNIT_DIR, { recursive: true });
    symlinkSync(elsewhere, UNIT);
    await daemonInstall();
    expect(lstatSync(UNIT).isSymbolicLink()).toBe(true);
    expect(readFileSync(elsewhere, "utf-8")).toBe(unitWith({}, 0));
    expect(execFileSync).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("says start at login isn't available without systemctl", async () => {
    vi.stubEnv("PATH", NO_BIN);
    await daemonInstall();
    expect(existsSync(UNIT_DIR)).toBe(false);
    expect(execFileSync).not.toHaveBeenCalled();
    const text = output();
    expect(text).toContain(
      "Start at login isn't available here: it needs a systemd user session ('systemctl --user').",
    );
    expect(text).toContain("Run 'engram start' to capture now, and again after you sign out or restart.");
    expect(process.exitCode).toBeUndefined();
  });

  it("says so when no user service manager answers", async () => {
    systemd.reachable = false;
    daemonRunning();
    await daemonInstall();
    expect(systemctlCalls()).toEqual(["show --property=Version"]);
    expect(existsSync(UNIT_DIR)).toBe(false);
    const text = output();
    expect(text).toContain("Start at login isn't available here");
    expect(text).toContain("The daemon keeps running until you sign out or restart.");
    expect(process.exitCode).toBeUndefined();
  });

  it("takes back a unit it wrote when systemd won't enable it, and says why", async () => {
    systemd.enableFails = true;
    await daemonInstall();
    expect(existsSync(UNIT)).toBe(false);
    expect(systemctlCalls()).toEqual(["show --property=Version", "daemon-reload", "enable engram.service", "daemon-reload"]);
    const text = output();
    expect(text).toContain("Couldn't turn on start at login.");
    expect(text).toContain("systemctl: Failed to enable unit: Access denied");
    expect(spawn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("keeps a unit of its own that was there before when systemd won't enable it", async () => {
    writeUnit(unitWith({}, 0), false);
    systemd.enableFails = true;
    await daemonInstall();
    expect(readFileSync(UNIT, "utf-8")).toBe(unitWith());
    expect(process.exitCode).toBe(1);
  });

  posixIt("refuses a home a unit can't hold, says why, and writes nothing", async () => {
    const restore = homeWithNewline();
    try {
      await daemonInstall();
    } finally {
      restore();
    }
    expect(existsSync(UNIT)).toBe(false);
    expect(systemctlCalls()).toEqual(["show --property=Version"]);
    const text = output();
    expect(text).toContain("Can't turn on start at login: a systemd unit can't hold one of the paths it needs.");
    // The worker's path as JSON: never a raw control character on the terminal.
    expect(text).toContain(JSON.stringify(join(home.dir, "new\nline", "cli", "dist", "daemon", "worker.js")));
    expect(text).not.toContain("new\nline");
    expect(spawn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("fails when this build has no worker to start", async () => {
    rmSync(WORKER);
    await daemonInstall();
    expect(existsSync(UNIT)).toBe(false);
    expect(output()).toContain(`Can't turn on start at login: ${WORKER} is missing.`);
    expect(spawn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

describe("engram uninstall on Linux (engram#615)", () => {
  /** Signals other than the probe's 0: none, the daemon keeps running. */
  function signals(): unknown[] {
    return vi.mocked(process.kill).mock.calls.filter(([, signal]) => signal !== 0);
  }

  it("disables and removes the unit, and leaves the daemon running", async () => {
    writeUnit(unitWith());
    daemonRunning();
    await daemonUninstall();
    expect(existsSync(UNIT)).toBe(false);
    expect(linked()).toBe(false);
    expect(systemctlCalls()).toEqual(["disable engram.service", "daemon-reload"]);
    const text = output();
    expect(text).toContain("Auto-start disabled — the systemd unit is removed");
    expect(text).toContain("The daemon keeps running until 'engram stop' or sign-out.");
    expect(signals()).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it("removes the link and the unit with no service manager to ask", async () => {
    writeUnit(unitWith());
    vi.stubEnv("PATH", NO_BIN);
    await daemonUninstall();
    expect(existsSync(UNIT)).toBe(false);
    expect(linked()).toBe(false);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(output()).toContain("Auto-start disabled");
    expect(output()).not.toContain("keeps running");
  });

  it("removes them when the service manager doesn't answer", async () => {
    writeUnit(unitWith());
    systemd.reachable = false;
    await daemonUninstall();
    expect(existsSync(UNIT)).toBe(false);
    expect(linked()).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it("removes the plist an older CLI wrote here, with or without a unit", async () => {
    for (const unit of [true, false]) {
      if (unit) writeUnit(unitWith());
      mkdirSync(dirname(STRAY_PLIST), { recursive: true });
      writeFileSync(STRAY_PLIST, "<plist/>");
      try {
        await daemonUninstall();
        expect(existsSync(STRAY_PLIST)).toBe(false);
        expect(existsSync(UNIT)).toBe(false);
      } finally {
        rmSync(join(home.dir, "Library"), { recursive: true, force: true });
      }
    }
  });

  it("removes one that is broken or outdated just the same", async () => {
    writeUnit(unitWith({ worker: join(home.dir, "gone", "worker.js") }, 0));
    await daemonUninstall();
    expect(existsSync(UNIT)).toBe(false);
    expect(linked()).toBe(false);
  });

  it("leaves a unit it didn't write as it is", async () => {
    const theirs = "[Service]\nExecStart=/usr/bin/true\n";
    writeUnit(theirs);
    await daemonUninstall();
    expect(readFileSync(UNIT, "utf-8")).toBe(theirs);
    expect(linked()).toBe(true);
    expect(execFileSync).not.toHaveBeenCalled();
    const text = output();
    expect(text).toContain("Auto-start isn't on.");
    expect(text).toContain(`${UNIT} isn't one Engram wrote, so it was left as it is.`);
    expect(process.exitCode).toBeUndefined();
  });

  it("says so when there is no unit", async () => {
    await daemonUninstall();
    expect(output()).toContain("Auto-start isn't on.");
    expect(execFileSync).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("fails, and says what to remove, when it can't remove the unit", async () => {
    writeUnit(unitWith(), false);
    // The link's place taken by a directory, which removing a link won't remove.
    mkdirSync(join(WANTS, "x"), { recursive: true });
    await daemonUninstall();
    expect(existsSync(UNIT)).toBe(true);
    const text = output();
    expect(text).toContain("Couldn't remove the systemd unit.");
    expect(text).toContain(`Remove ${UNIT} to turn start at login off.`);
    expect(text).not.toContain("Auto-start disabled");
    expect(process.exitCode).toBe(1);
  });
});

describe("engram status on Linux (engram#615)", () => {
  it("says start at login is on", async () => {
    writeUnit(unitWith());
    systemdRunsDaemon();
    await daemonStatus();
    const text = output();
    expect(text).toContain("Auto-start: enabled (systemd)");
    expect(text).not.toContain("outdated");
    expect(text).not.toContain("broken");
    expect(text).not.toContain("wasn't started by systemd");
    // Only which daemon systemd runs (engram#689).
    expect(systemctlCalls()).toEqual(["show engram.service --property=MainPID"]);
  });

  it("says it's off when it was disabled with systemctl", async () => {
    writeUnit(unitWith(), false);
    daemonRunning();
    await daemonStatus();
    expect(output()).toContain("Auto-start: off — disabled with systemctl  ('engram install' turns it back on)");
  });

  it("says a unit whose programs are gone is broken", async () => {
    for (const gone of [{ worker: join(home.dir, "gone", "worker.js") }, { node: join(home.dir, "gone", "node") }]) {
      writeUnit(unitWith(gone));
      daemonRunning();
      await daemonStatus();
      expect(said()).toContain("Auto-start: enabled (systemd)  — broken, run 'engram install' to repair");
    }
  });

  it("says a unit it can't make out is broken", async () => {
    const exec = /^ExecStart=(.*)$/m.exec(unitWith())![1];
    for (const other of [
      "/bin/sh -c 'exec %h/node'", // a specifier
      exec.replace("/bin/sh -c", "/bin/bash -c"), // not the shell it runs
      exec.replace("/bin/sh -c", "/bin/sh -e"),
      execWord("/bin/sh") + " -c true engram " + execWord(NODE), // a word short of the worker
    ]) {
      // A function, so that `$$` in the unit is put back as it is.
      writeUnit(unitWith().replace(/^ExecStart=.*$/m, () => `ExecStart=${other}`));
      daemonRunning();
      await daemonStatus();
      expect(said()).toContain("broken, run 'engram install' to repair");
    }
  });

  it("says an older unit is outdated", async () => {
    writeUnit(unitWith({}, 0));
    daemonRunning();
    await daemonStatus();
    expect(output()).toContain("Auto-start: enabled (systemd)  — outdated config, run 'engram install' to update");
  });

  it("points at what repairs or updates it while the daemon runs: engram install (engram#651)", async () => {
    for (const unit of [unitWith({}, 0), unitWith({ node: join(home.dir, "gone", "node") })]) {
      writeUnit(unit);
      // systemd started it, from a Node the next upgrade then removed, say.
      systemdRunsDaemon();
      await daemonStatus();
      expect(said()).toMatch(/^Auto-start: enabled \(systemd\) {2}— (broken|outdated config), run 'engram install' to (repair|update)$/m);
      // engram start finds the daemon running, and repairs nothing.
      await daemonStart([], {});
      expect(readFileSync(UNIT, "utf-8")).toBe(unit);
      expect(said()).toContain("Daemon already running");
      await daemonInstall();
      expect(readFileSync(UNIT, "utf-8")).toBe(unitWith());
      expect(spawn).not.toHaveBeenCalled();
      expect(said()).toContain("Auto-start enabled — daemon will start when you log in (systemd)");
      await daemonStatus();
      const after = said();
      expect(after).toContain("Auto-start: enabled (systemd)");
      expect(after).not.toMatch(/broken|outdated|engram start/);
    }
  });

  it("says nothing of a unit it didn't write, or of none", async () => {
    daemonRunning();
    await daemonStatus();
    writeUnit("[Service]\nExecStart=/usr/bin/true\n");
    await daemonStatus();
    expect(output()).not.toContain("Auto-start");
  });

  it("says the daemon should be running when start at login is on and it isn't", async () => {
    writeUnit(unitWith());
    await daemonStatus();
    expect(said()).toContain("It should be running: start at login is on.");

    // Not when start at login is broken: that is why, and status says so.
    writeUnit(unitWith({ node: join(home.dir, "gone", "node") }));
    await daemonStatus();
    const text = said();
    expect(text).toContain("broken");
    expect(text).not.toContain("It should be running");
  });
});

describe("engram start on Linux (engram#615)", () => {
  it("updates an older unit it wrote, and leaves it enabled", async () => {
    writeUnit(unitWith({}, 0));
    await daemonStart([], {});
    expect(readFileSync(UNIT, "utf-8")).toBe(unitWith());
    expect(linked()).toBe(true);
    // Then systemd starts the daemon, from the unit as it is now (engram#689).
    expect(systemctlCalls()).toEqual(["daemon-reload", ...THROUGH_SYSTEMD]);
    const text = output();
    expect(text).toContain(`Updated auto-start configuration (systemd unit v${UNIT_VERSION})`);
    expect(spawn).not.toHaveBeenCalled();
    expect(systemd.mainPid).toBe(process.pid);
    expect(text).toContain(`Engram daemon started (pid ${process.pid})`);
    expect(process.exitCode).toBeUndefined();
  });

  it("points a unit whose Node or CLI is gone at this one", async () => {
    for (const gone of [{ node: join(home.dir, "gone", "node") }, { worker: join(home.dir, "gone", "worker.js") }]) {
      writeUnit(unitWith(gone));
      daemonGone();
      await daemonStart([], {});
      expect(readFileSync(UNIT, "utf-8")).toBe(unitWith());
      expect(said()).toContain("Updated auto-start configuration");
    }
  });

  it("leaves a unit the user disabled as it is, older or not", async () => {
    const old = unitWith({ node: join(home.dir, "gone", "node") }, 0);
    writeUnit(old, false);
    await daemonStart([], {});
    expect(readFileSync(UNIT, "utf-8")).toBe(old);
    expect(linked()).toBe(false);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(output()).not.toContain("Updated auto-start configuration");
  });

  it("leaves a current unit, and one it didn't write, as they are", async () => {
    writeUnit(unitWith());
    await daemonStart([], {});
    expect(readFileSync(UNIT, "utf-8")).toBe(unitWith());
    // Started through it (engram#689): nothing rewritten, nothing reloaded.
    expect(systemctlCalls()).toEqual(THROUGH_SYSTEMD);

    daemonGone();
    execFileSync.mockClear();
    writeUnit("[Service]\nExecStart=/usr/bin/true\n");
    await daemonStart([], {});
    expect(readFileSync(UNIT, "utf-8")).toBe("[Service]\nExecStart=/usr/bin/true\n");
    expect(execFileSync).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(output()).not.toContain("Updated auto-start configuration");
  });

  it("updates the unit with no service manager to tell", async () => {
    writeUnit(unitWith({}, 0));
    vi.stubEnv("PATH", NO_BIN);
    await daemonStart([], {});
    expect(readFileSync(UNIT, "utf-8")).toBe(unitWith());
    expect(execFileSync).not.toHaveBeenCalled();
    expect(output()).toContain("Updated auto-start configuration");
  });

  it("leaves the unit alone off Linux, as in a home shared with a Mac", () => {
    const old = unitWith({ node: join(home.dir, "gone", "node") }, 0);
    writeUnit(old);
    for (const platform of ["darwin", "win32"]) {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      expect(repairSystemdUnitIfStale()).toBe(false);
    }
    expect(readFileSync(UNIT, "utf-8")).toBe(old);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(output()).not.toContain("Updated auto-start configuration");
  });

  permissionsIt("says nothing of an update it couldn't write, and starts the daemon all the same", async () => {
    const old = unitWith({}, 0);
    writeUnit(old);
    chmodSync(UNIT_DIR, 0o555);
    try {
      await daemonStart([], {});
    } finally {
      chmodSync(UNIT_DIR, 0o755);
    }
    expect(readFileSync(UNIT, "utf-8")).toBe(old);
    expect(readdirSync(UNIT_DIR).sort()).toEqual(["default.target.wants", "engram.service"]);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(output()).not.toContain("Updated auto-start configuration");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  posixIt("starts the daemon all the same when a unit can't hold this home, and leaves the unit as it is", async () => {
    const old = unitWith({}, 0);
    writeUnit(old);
    const restore = homeWithNewline();
    try {
      await daemonStart([], {});
    } finally {
      restore();
    }
    expect(readFileSync(UNIT, "utf-8")).toBe(old);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(output()).not.toContain("Updated auto-start configuration");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
  });

  it("leaves the unit as it is when this build has no worker", async () => {
    const old = unitWith({}, 0);
    writeUnit(old);
    rmSync(WORKER);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    spawn.mockImplementation(failingSpawn);
    await daemonStart([], {});
    expect(readFileSync(UNIT, "utf-8")).toBe(old);
    expect(output()).not.toContain("Updated auto-start configuration");
    expect(exit).toHaveBeenCalledWith(1);
  });
});

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
    config.mockResolvedValue({ apiKey: "eng_test_615" } as never);
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: realIsTTY, configurable: true });
    config.mockReset().mockImplementation(async () => ({}) as never);
  });
}

describe("auto-capture on Linux (engram#615)", () => {
  signedInAtATerminal();

  it("turns on start at login after sign-in, has systemd start the daemon, then says nothing more", async () => {
    await autoEnableCapture({ after: "login" });
    // Start at login first; then systemd starts the daemon, and starts it
    // again after a crash (engram#689). Nothing waits on it here.
    expect(systemctlCalls()).toEqual([...ENABLE, "show --property=Version", "start engram.service"]);
    expect(spawn).not.toHaveBeenCalled();
    expect(systemd.mainPid).toBe(process.pid);
    const text = said();
    expect(text).toContain("Auto-start enabled — daemon will start when you log in (systemd)");
    expect(text).toContain("Auto-capture is on");
    expect(text).not.toContain("isn't available");
    expect(readFileSync(UNIT, "utf-8")).toBe(unitWith());
    expect(linked()).toBe(true);

    execFileSync.mockClear();
    for (let command = 0; command < 3; command++) {
      await autoEnableCapture({ after: "command" });
      expect(said()).toBe("");
    }
    expect(execFileSync).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("turns on start at login after any other command, and says so", async () => {
    daemonRunning();
    await autoEnableCapture({ after: "command" });
    expect(spawn).not.toHaveBeenCalled();
    const text = said();
    expect(text).toContain("Auto-start enabled");
    expect(text).toContain("Auto-capture is on");
    expect(linked()).toBe(true);
  });

  it("leaves start at login off when it was turned off with systemctl", async () => {
    writeUnit(unitWith({}, 0), false);
    daemonRunning();
    await autoEnableCapture({ after: "command" });
    await autoEnableCapture({ after: "login" });
    expect(linked()).toBe(false);
    expect(readFileSync(UNIT, "utf-8")).toBe(unitWith({}, 0));
    expect(execFileSync).not.toHaveBeenCalled();
    expect(said()).not.toContain("Auto-start enabled");
  });

  it("updates an outdated unit of its own, says so once, then nothing", async () => {
    writeUnit(unitWith({}, 0));
    daemonRunning();
    await autoEnableCapture({ after: "command" });
    expect(readFileSync(UNIT, "utf-8")).toBe(unitWith());
    const text = said();
    expect(text).toContain("Updated auto-start configuration");
    expect(text).toContain("Auto-capture is on");

    await autoEnableCapture({ after: "command" });
    expect(said()).toBe("");
  });

  it("never touches a unit it didn't write", async () => {
    writeUnit("[Service]\nExecStart=/usr/bin/true\n", false);
    daemonRunning();
    await autoEnableCapture({ after: "command" });
    expect(readFileSync(UNIT, "utf-8")).toBe("[Service]\nExecStart=/usr/bin/true\n");
    expect(linked()).toBe(false);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(said()).toBe("");
  });

  it("without a systemd user session, says so after sign-in or when it starts the daemon, else nothing", async () => {
    systemd.reachable = false;
    daemonRunning();
    await autoEnableCapture({ after: "command" });
    expect(said()).toBe("");

    await autoEnableCapture({ after: "login" });
    let text = said();
    expect(text).toContain("Auto-capture is on");
    expect(text).toContain(
      "Start at login isn't available here (no systemd user session): run 'engram start' after a restart.",
    );

    daemonGone();
    await autoEnableCapture({ after: "command" });
    expect(spawn).toHaveBeenCalledTimes(1);
    // The worker itself, with no supervisor: systemd is the one that restarts it.
    // (launch.ts names the worker beside itself, not through the mock above.)
    expect(spawn.mock.calls[0][1]).toEqual([expect.stringMatching(/[\\/]worker\.js$/)]);
    text = said();
    expect(text).toContain("Auto-capture is on");
    expect(text).toContain("Start at login isn't available here");
    expect(existsSync(UNIT_DIR)).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it("without systemctl at all, likewise", async () => {
    vi.stubEnv("PATH", NO_BIN);
    await autoEnableCapture({ after: "login" });
    const text = said();
    expect(text).toContain("Auto-capture is on");
    expect(text).toContain("Start at login isn't available here");
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("says it can't turn on start at login when it had to start the daemon, not after every command", async () => {
    systemd.enableFails = true;
    daemonRunning();
    await autoEnableCapture({ after: "command" });
    expect(said()).toBe("");
    expect(existsSync(UNIT)).toBe(false);

    daemonGone();
    await autoEnableCapture({ after: "command" });
    expect(spawn).toHaveBeenCalledTimes(1);
    const text = said();
    expect(text).toContain("Couldn't turn on start at login. Run 'engram install' to try again.");
    expect(text).toContain("Auto-capture is on");
    expect(text).not.toContain("isn't available");
    expect(existsSync(UNIT)).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  posixIt("says it couldn't turn on start at login when a unit can't hold this home", async () => {
    const restore = homeWithNewline();
    try {
      await autoEnableCapture({ after: "login" });
    } finally {
      restore();
    }
    expect(systemctlCalls()).toEqual(["show --property=Version"]);
    const text = said();
    expect(text).toContain("Couldn't turn on start at login. Run 'engram install' to try again.");
    expect(text).toContain("Auto-capture is on");
    expect(existsSync(UNIT)).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it("leaves start at login alone in a source checkout, which has no worker.js", async () => {
    rmSync(WORKER);
    daemonRunning();
    await autoEnableCapture({ after: "login" });
    expect(existsSync(UNIT_DIR)).toBe(false);
    expect(execFileSync).not.toHaveBeenCalled();
    const text = said();
    expect(text).toContain("Auto-capture is on");
    expect(text).not.toContain("Start at login");
  });
});

describe("engram start through systemd (engram#689)", () => {
  /** What systemctl says when the unit has failed too often to be started again for now. */
  const START_LIMIT =
    "Job for engram.service failed because start of the service was attempted too often.\n" +
    'See "systemctl --user status engram.service" and "journalctl --user -xeu engram.service" for details.\n';

  beforeEach(() => writeUnit(unitWith()));

  it("has systemd start the daemon when the unit is enabled: systemd starts it again after a crash", async () => {
    await daemonStart([], {});
    // Whether the user service manager answers; the start; and the PID
    // systemd gave the daemon.
    expect(systemctlCalls()).toEqual(THROUGH_SYSTEMD);
    expect(spawn).not.toHaveBeenCalled();
    expect(systemd.mainPid).toBe(process.pid);
    const text = output();
    expect(text).toContain(`Engram daemon started (pid ${process.pid})`);
    expect(text).toContain(`Log: ${LOG_FILE}`);
    expect(text).not.toMatch(/systemd|started directly/);
    expect(process.exitCode).toBeUndefined();
  });

  it("leaves the daemon systemd runs as it is, and says nothing of systemd", async () => {
    systemdRunsDaemon();
    await daemonStart([], {});
    // Only which daemon systemd runs: this one.
    expect(systemctlCalls()).toEqual(["show engram.service --property=MainPID"]);
    expect(spawn).not.toHaveBeenCalled();
    const text = output();
    expect(text).toContain(`Daemon already running (pid ${process.pid})`);
    expect(text).not.toContain("systemd");
  });

  it("starts the daemon itself, and says systemd won't restart it, when systemctl won't start it", async () => {
    systemd.startRefusal = START_LIMIT;
    await daemonStart([], {});
    expect(systemctlCalls()).toEqual(THROUGH_SYSTEMD.slice(0, 2));
    expect(spawn).toHaveBeenCalledTimes(1);
    const text = output();
    // What it said, in its first line: not where to look.
    expect(text).toContain(
      startedDirectly("Job for engram.service failed because start of the service was attempted too often."),
    );
    expect(text).not.toContain("journalctl");
    expect(text).toContain(`Engram daemon started (pid ${process.pid})`);
    expect(process.exitCode).toBeUndefined();
  });

  it("fails when the daemon systemd starts exits as it starts, and starts no other", async () => {
    systemd.starts = "dies";
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await daemonStart([], {});
    expect(exit).toHaveBeenCalledWith(1);
    expect(spawn).not.toHaveBeenCalled();
    // Its PID, asked for once systemd started it: systemd names it until the next.
    expect(systemctlCalls()).toEqual(THROUGH_SYSTEMD);
    expect(systemd.mainPid).toBe(0);
    const text = output();
    expect(text).toContain("Daemon failed to start. Check the log:");
    expect(text).not.toContain("started directly");
  });

  it("starts the daemon itself, and says so, when systemd hasn't started one in time", async () => {
    systemd.starts = "never";
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => (now += 1_000));
    try {
      await daemonStart([], {});
    } finally {
      clock.mockRestore();
    }
    const calls = systemctlCalls();
    expect(calls.slice(0, 3)).toEqual(THROUGH_SYSTEMD);
    // Then the PID systemd gave the daemon, asked for until it gives up.
    expect(calls.slice(3).length).toBeGreaterThan(0);
    expect(new Set(calls.slice(3))).toEqual(new Set(["show engram.service --property=ExecMainPID"]));
    expect(spawn).toHaveBeenCalledTimes(1);
    const text = output();
    expect(text).toContain(
      "systemd didn't start the daemon in time, so it is started directly, and won't be restarted after a crash.",
    );
    expect(text).toContain(`Engram daemon started (pid ${process.pid})`);
    expect(process.exitCode).toBeUndefined();
  });

  it("starts the daemon itself with a key, a server or the vault key set here: systemd's wouldn't have them", async () => {
    for (const [name, value] of [
      ["ENGRAM_API_KEY", "eng_test_689"],
      ["ENGRAM_BASE_URL", "http://127.0.0.1:9"],
      ["ENGRAM_VAULT_KEY", "test-vault-key-689"],
    ]) {
      daemonGone();
      execFileSync.mockClear();
      spawn.mockClear();
      vi.stubEnv(name, value);
      await daemonStart([], {});
      // Not even whether the user service manager answers.
      expect(systemctlCalls()).toEqual([]);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(said()).not.toContain("systemd");
      vi.stubEnv(name, undefined);
    }

    // A server that is only spaces is none, as the daemon reads it.
    daemonGone();
    execFileSync.mockClear();
    spawn.mockClear();
    vi.stubEnv("ENGRAM_BASE_URL", "  ");
    await daemonStart([], {});
    expect(systemctlCalls()).toEqual(THROUGH_SYSTEMD);
    expect(spawn).not.toHaveBeenCalled();
    vi.stubEnv("ENGRAM_BASE_URL", undefined);

    // The vault key, saved where systemd's daemon reads it (engram#690).
    const vaultKey = join(ENGRAM_DIR, "vault-key");
    daemonGone();
    execFileSync.mockClear();
    vi.stubEnv("ENGRAM_VAULT_KEY", "test-vault-key-689");
    mkdirSync(ENGRAM_DIR, { recursive: true });
    writeFileSync(vaultKey, "test-vault-key-689\n", { mode: 0o600 });
    try {
      await daemonStart([], {});
    } finally {
      rmSync(vaultKey, { force: true });
    }
    expect(systemctlCalls()).toEqual(THROUGH_SYSTEMD);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("starts the daemon itself, saying nothing of systemd, where systemd can't run this CLI's", async () => {
    const otherWorker = join(home.dir, "other-cli", "dist", "daemon", "worker.js");
    mkdirSync(dirname(otherWorker), { recursive: true });
    writeFileSync(otherWorker, "");
    for (const [unit, enabled] of [
      [unitWith(), false], // disabled with systemctl: left to the user
      ["[Service]\nExecStart=/usr/bin/true\n", true], // not Engram's
      [unitWith({}, UNIT_VERSION + 1), true], // a newer CLI's
      [unitWith({ worker: otherWorker }), true], // another CLI's, still there
    ] as const) {
      rmSync(WANTS, { force: true });
      writeUnit(unit, enabled);
      daemonGone();
      execFileSync.mockClear();
      spawn.mockClear();
      await daemonStart([], {});
      expect(readFileSync(UNIT, "utf-8")).toBe(unit);
      expect(linked()).toBe(enabled);
      expect(systemctlCalls()).toEqual([]);
      expect(spawn).toHaveBeenCalledTimes(1);
      const text = said();
      expect(text).toContain(`Engram daemon started (pid ${process.pid})`);
      expect(text).not.toContain("systemd");
    }
  });

  it("starts the daemon itself, saying nothing of systemd, when the user's service manager doesn't answer, or there is none", async () => {
    systemd.reachable = false;
    await daemonStart([], {});
    expect(systemctlCalls()).toEqual(["show --property=Version"]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(said()).not.toContain("systemd");

    daemonGone();
    execFileSync.mockClear();
    spawn.mockClear();
    vi.stubEnv("PATH", NO_BIN);
    await daemonStart([], {});
    expect(execFileSync).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(said()).not.toContain("systemd");
  });

  describe("engram start --install", () => {
    beforeEach(() => rmSync(CONFIG, { recursive: true, force: true }));

    it("turns start at login on first, and then systemd starts the daemon", async () => {
      await daemonStart([], { install: "" });
      // Whether there is a user session to turn it on in; the unit, enabled;
      // the start through it.
      expect(systemctlCalls()).toEqual(["show --property=Version", ...ENABLE, ...THROUGH_SYSTEMD]);
      expect(readFileSync(UNIT, "utf-8")).toBe(unitWith());
      expect(linked()).toBe(true);
      expect(spawn).not.toHaveBeenCalled();
      expect(systemd.mainPid).toBe(process.pid);
      const text = output();
      expect(text.indexOf("Auto-start enabled")).toBeGreaterThanOrEqual(0);
      expect(text.indexOf("Auto-start enabled")).toBeLessThan(text.indexOf("Engram daemon started"));
      expect(text).not.toMatch(/started directly|wasn't started by systemd/);
      expect(process.exitCode).toBeUndefined();
    });

    it("with a key set here, starts the daemon itself first, as before", async () => {
      vi.stubEnv("ENGRAM_API_KEY", "eng_test_689");
      await daemonStart([], { install: "" });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(systemctlCalls()).toEqual(ENABLE);
      expect(spawn.mock.invocationCallOrder[0]).toBeLessThan(execFileSync.mock.invocationCallOrder[0]);
      expect(linked()).toBe(true);
      const text = output();
      expect(text.indexOf("Engram daemon started")).toBeGreaterThanOrEqual(0);
      expect(text.indexOf("Engram daemon started")).toBeLessThan(text.indexOf("Auto-start enabled"));
      expect(process.exitCode).toBeUndefined();
    });

    it("without a systemd user session, starts the daemon, then says start at login isn't available, as before", async () => {
      systemd.reachable = false;
      await daemonStart([], { install: "" });
      // Whether there is a session: for --install, and again as it turns start at login on.
      expect(systemctlCalls()).toEqual(["show --property=Version", "show --property=Version"]);
      expect(spawn).toHaveBeenCalledTimes(1);
      const text = output();
      expect(text.indexOf("Engram daemon started")).toBeGreaterThanOrEqual(0);
      expect(text.indexOf("Engram daemon started")).toBeLessThan(text.indexOf("Start at login isn't available here"));
      expect(existsSync(UNIT_DIR)).toBe(false);
      expect(process.exitCode).toBeUndefined();
    });

    it("starts the daemon itself, and fails, when systemd won't turn start at login on", async () => {
      systemd.enableFails = true;
      await daemonStart([], { install: "" });
      expect(systemctlCalls()).toEqual(["show --property=Version", ...ENABLE, "daemon-reload"]);
      expect(existsSync(UNIT)).toBe(false);
      expect(spawn).toHaveBeenCalledTimes(1);
      const text = output();
      expect(text).toContain("Couldn't turn on start at login.");
      expect(text).toContain(`Engram daemon started (pid ${process.pid})`);
      expect(process.exitCode).toBe(1);
    });

    it("finds the daemon running: turns start at login on, starts none, and says systemd won't restart that one", async () => {
      daemonRunning();
      await daemonStart([], { install: "" });
      expect(systemctlCalls()).toEqual([...ENABLE, "show engram.service --property=MainPID"]);
      expect(spawn).not.toHaveBeenCalled();
      const text = output();
      expect(text).toContain(`Daemon already running (pid ${process.pid})`);
      expect(text).toContain("Auto-start enabled");
      expect(text).toContain(OUTSIDE_SYSTEMD);
      expect(process.exitCode).toBeUndefined();
    });
  });

  describe("auto-capture", () => {
    signedInAtATerminal();

    it("has systemd start the daemon when the unit is there already", async () => {
      await autoEnableCapture({ after: "command" });
      expect(systemctlCalls()).toEqual(["show --property=Version", "start engram.service"]);
      expect(spawn).not.toHaveBeenCalled();
      expect(systemd.mainPid).toBe(process.pid);
      expect(said()).toContain("Auto-capture is on");
    });

    it("starts the daemon itself when systemctl won't start it", async () => {
      systemd.startRefusal = START_LIMIT;
      await autoEnableCapture({ after: "command" });
      expect(systemctlCalls()).toEqual(["show --property=Version", "start engram.service"]);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(said()).toContain("Auto-capture is on");
      expect(process.exitCode).toBeUndefined();
    });

    it("starts the daemon itself while one is stopping: systemd would take that one for its own", async () => {
      daemonStopping();
      await autoEnableCapture({ after: "command" });
      expect(systemctlCalls()).toEqual([]);
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it("with a key set here, starts the daemon itself first, then turns start at login on", async () => {
      rmSync(CONFIG, { recursive: true, force: true });
      vi.stubEnv("ENGRAM_API_KEY", "eng_test_689");
      await autoEnableCapture({ after: "login" });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(systemctlCalls()).toEqual(ENABLE);
      expect(spawn.mock.invocationCallOrder[0]).toBeLessThan(execFileSync.mock.invocationCallOrder[0]);
      expect(linked()).toBe(true);
    });
  });

  describe("a daemon systemd doesn't run", () => {
    it("is said when systemd could run it: a stop and a start hand it to systemd", async () => {
      daemonRunning();
      await daemonStart([], {});
      expect(systemctlCalls()).toEqual(["show engram.service --property=MainPID"]);
      expect(spawn).not.toHaveBeenCalled();
      const text = output();
      expect(text).toContain(`Daemon already running (pid ${process.pid})`);
      expect(text).toContain(OUTSIDE_SYSTEMD);
    });

    it("is said by engram status, under its Auto-start line", async () => {
      daemonRunning();
      await daemonStatus();
      expect(systemctlCalls()).toEqual(["show engram.service --property=MainPID"]);
      const text = said();
      expect(text).toContain(`Status: running (pid ${process.pid})`);
      expect(text).toContain(`Auto-start: enabled (systemd)\n  ${OUTSIDE_SYSTEMD}`);
    });

    it("isn't said for systemd's own daemon, or where systemd couldn't run it", async () => {
      /** What `engram start` and `engram status` said, and the systemctl calls each made. */
      const startAndStatus = async () => {
        execFileSync.mockClear();
        await daemonStart([], {});
        const started = { text: said(), calls: systemctlCalls() };
        expect(started.text).toContain("Daemon already running");
        execFileSync.mockClear();
        await daemonStatus();
        const status = { text: said(), calls: systemctlCalls() };
        for (const { text } of [started, status]) expect(text).not.toContain("wasn't started by systemd");
        expect(spawn).not.toHaveBeenCalled();
        return { started, status };
      };

      // systemd's own.
      systemdRunsDaemon();
      let found = await startAndStatus();
      expect(found.started.calls).toEqual(["show engram.service --property=MainPID"]);
      expect(found.status.calls).toEqual(["show engram.service --property=MainPID"]);
      expect(found.status.text).toContain("Auto-start: enabled (systemd)");

      // The user service manager doesn't answer: none to start it.
      systemd.mainPid = 0;
      systemd.reachable = false;
      found = await startAndStatus();
      expect(found.started.calls).toEqual(["show engram.service --property=MainPID"]);
      expect(found.status.calls).toEqual(["show engram.service --property=MainPID"]);
      systemd.reachable = true;

      // It answers, but with no PID that can be read: it isn't taken to run none.
      systemd.pidUnreadable = true;
      found = await startAndStatus();
      expect(found.started.calls).toEqual(["show engram.service --property=MainPID"]);
      expect(found.status.calls).toEqual(["show engram.service --property=MainPID"]);
      systemd.pidUnreadable = false;

      // A key set here, which systemd's daemon wouldn't have.
      vi.stubEnv("ENGRAM_API_KEY", "eng_test_689");
      found = await startAndStatus();
      expect(found.started.calls).toEqual([]);
      expect(found.status.calls).toEqual([]);
      expect(found.status.text).toContain("Auto-start: enabled (systemd)");
      vi.stubEnv("ENGRAM_API_KEY", undefined);

      // Disabled with systemctl; outdated, broken, or not Engram's: status says
      // so, or nothing, and `engram install` sees to it.
      for (const [unit, enabled, says] of [
        [unitWith(), false, "Auto-start: off — disabled with systemctl"],
        [unitWith({}, 0), true, "outdated config"],
        [unitWith({ node: join(home.dir, "gone", "node") }), true, "broken"],
        ["[Service]\nExecStart=/usr/bin/true\n", true, null],
      ] as const) {
        rmSync(WANTS, { force: true });
        writeUnit(unit, enabled);
        found = await startAndStatus();
        expect(found.started.calls).toEqual([]);
        expect(found.status.calls).toEqual([]);
        if (says === null) expect(found.status.text).not.toContain("Auto-start");
        else expect(found.status.text).toContain(says);
        // engram start, finding the daemon running, repairs nothing.
        expect(readFileSync(UNIT, "utf-8")).toBe(unit);
      }
    });

    it("isn't said when the daemon is another version's: the version hint says to stop and start it", async () => {
      daemonRunning();
      daemon.answering = { pid: process.pid, version: "0.0.1" };
      await daemonStart([], {});
      const text = output();
      expect(text).toContain("It runs version 0.0.1");
      expect(text).not.toContain("wasn't started by systemd");
      expect(systemctlCalls()).toEqual([]);
    });
  });

  it("waits on the PID it is given for the daemon: systemd's, not launchd's", async () => {
    // One that exited as it started: failed, at once.
    expect(await waitForAgent(5_000, 200, () => DEAD_PID)).toEqual({ state: "failed" });
    // None started yet: given up on, for a spawn, and asked for again meanwhile.
    const none = vi.fn((): number | null => null);
    const started = Date.now();
    expect(await waitForAgent(5_000, 200, none)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(none.mock.calls.length).toBeGreaterThan(1);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});

describe("the vault key a daemon started at login reads (engram#690)", () => {
  signedInAtATerminal();

  const VAULT_KEY = join(ENGRAM_DIR, "vault-key");
  /** The key in ENGRAM_VAULT_KEY here, and another. */
  const KEY = Buffer.alloc(32, 7).toString("base64");
  const OTHER = Buffer.alloc(32, 9).toString("base64");
  /** What is said when the file isn't there. */
  const NONE = [
    "  WARNING: ENGRAM_VAULT_KEY is set here, but ~/.engram/vault-key isn't there.",
    "  A daemon started at login may not get this shell's variables. Then it has no",
    "  vault key, and your vault's secrets aren't removed from what it captures.",
    "  To save the key there, readable only by you: engram vault save-key",
  ];
  /** What is said when it holds another key. */
  const DIFFERENT = [
    "  WARNING: ~/.engram/vault-key holds a different vault key from ENGRAM_VAULT_KEY.",
    "  A daemon started at login may not get this shell's variables. Then it uses the",
    "  file's key, and secrets encrypted with ENGRAM_VAULT_KEY's aren't removed from",
    "  what it captures. If ENGRAM_VAULT_KEY's key is the right one:",
    "  engram vault save-key --force (the file's key is backed up first).",
    "  If the file's is, unset ENGRAM_VAULT_KEY.",
  ];

  beforeEach(() => {
    vi.stubEnv("NO_COLOR", "1");
    vi.stubEnv("ENGRAM_VAULT_KEY", KEY);
    rmSync(VAULT_KEY, { force: true });
  });

  afterEach(() => rmSync(VAULT_KEY, { force: true }));

  function saveKey(text: string): void {
    mkdirSync(ENGRAM_DIR, { recursive: true });
    writeFileSync(VAULT_KEY, text, { mode: 0o600 });
  }

  /**
   * Where `warning` was said in `text`, a line on its own between blank
   * ones; -1 when it wasn't. Fails when it was said more than once.
   */
  function warnedAt(text: string, warning: string[]): number {
    const lines = text.split("\n");
    const at = lines.indexOf(warning[0]);
    if (at === -1) return -1;
    expect(lines.slice(at - 1, at + warning.length + 1)).toEqual(["", ...warning, ""]);
    expect(lines.indexOf(warning[0], at + 1)).toBe(-1);
    return at;
  }

  /** Neither warning was said. */
  function noWarning(text: string): void {
    expect(text).not.toContain("ENGRAM_VAULT_KEY");
    expect(text).not.toContain("save-key");
  }

  describe("engram install", () => {
    it("warns, after the unit, when ~/.engram/vault-key isn't there", async () => {
      await daemonInstall();
      const text = output();
      const lines = text.split("\n");
      const at = warnedAt(text, NONE);
      expect(at).toBeGreaterThan(lines.indexOf(`Unit: ${UNIT}`));
      expect(at).toBeLessThan(lines.findIndex((line) => line.includes("Engram daemon started")));
      expect(linked()).toBe(true);
      expect(process.exitCode).toBeUndefined();
    });

    it("warns when it holds another key", async () => {
      saveKey(`${OTHER}\n`);
      await daemonInstall();
      const text = output();
      expect(warnedAt(text, DIFFERENT)).toBeGreaterThan(-1);
      expect(warnedAt(text, NONE)).toBe(-1);
      // Neither key is ever printed.
      expect(text).not.toContain(KEY.slice(0, 12));
      expect(text).not.toContain(OTHER.slice(0, 12));
    });

    it("says nothing when it holds this key, however written", async () => {
      for (const saved of [`${KEY}\n`, `  ${KEY}\n\n`, KEY.replace(/=+$/, "")]) {
        saveKey(saved);
        await daemonInstall();
        noWarning(said());
      }
    });

    it("says nothing without a key here, or with one that isn't a vault key", async () => {
      for (const env of [undefined, "", "not-a-vault-key", Buffer.alloc(16, 7).toString("base64")]) {
        vi.stubEnv("ENGRAM_VAULT_KEY", env);
        await daemonInstall();
        noWarning(said());
      }
    });

    it("says nothing when start at login isn't available, or wasn't turned on", async () => {
      vi.stubEnv("PATH", NO_BIN);
      await daemonInstall();
      noWarning(said());

      vi.stubEnv("PATH", BIN);
      systemd.enableFails = true;
      await daemonInstall();
      const text = said();
      expect(text).toContain("Couldn't turn on start at login.");
      noWarning(text);
    });
  });

  describe("engram status", () => {
    it("warns while the daemon runs, after the line on start at login", async () => {
      writeUnit(unitWith());
      daemonRunning();
      await daemonStatus();
      const text = output();
      const lines = text.split("\n");
      expect(warnedAt(text, NONE)).toBeGreaterThan(lines.indexOf("Auto-start: enabled (systemd)"));
      expect(execFileSync).not.toHaveBeenCalled();
    });

    it("warns while it is stopped, and when the file holds another key", async () => {
      writeUnit(unitWith());
      saveKey(OTHER);
      await daemonStatus();
      const text = output();
      expect(text).toContain("Status: stopped");
      expect(warnedAt(text, DIFFERENT)).toBeGreaterThan(-1);
    });

    it("says nothing when start at login is off, broken, or not ours, running or stopped", async () => {
      for (const unit of [
        () => writeUnit(unitWith(), false),
        () => writeUnit(unitWith({ node: join(home.dir, "gone", "node") })),
        () => writeUnit("[Service]\nExecStart=/usr/bin/true\n"),
        () => rmSync(CONFIG, { recursive: true, force: true }),
      ]) {
        for (const running of [true, false]) {
          if (running) daemonRunning();
          else daemonGone();
          unit();
          await daemonStatus();
          const text = said();
          expect(text).toContain(running ? "Status: running" : "Status: stopped");
          noWarning(text);
        }
      }
    });

    it("says nothing when the file holds this key", async () => {
      writeUnit(unitWith());
      saveKey(`${KEY}\n`);
      daemonRunning();
      await daemonStatus();
      const text = output();
      expect(text).toContain("Auto-start: enabled (systemd)");
      noWarning(text);
    });
  });

  describe("auto-capture", () => {
    it("warns after sign-in, when it turns on start at login, then says nothing more", async () => {
      await autoEnableCapture({ after: "login" });
      const text = said();
      expect(warnedAt(text, NONE)).toBeGreaterThan(text.split("\n").indexOf("  Turn off anytime: engram stop && engram uninstall"));
      expect(linked()).toBe(true);

      await autoEnableCapture({ after: "command" });
      expect(said()).toBe("");
    });

    it("warns when start at login was on already", async () => {
      writeUnit(unitWith());
      daemonRunning();
      saveKey(OTHER);
      await autoEnableCapture({ after: "login" });
      expect(warnedAt(said(), DIFFERENT)).toBeGreaterThan(-1);
    });

    it("says nothing when start at login is off: switched off, not ours, unavailable, failed, or no worker.js", async () => {
      daemonRunning();
      const cases: Array<() => void> = [
        () => writeUnit(unitWith(), false),
        () => writeUnit("[Service]\nExecStart=/usr/bin/true\n", false),
        () => vi.stubEnv("PATH", NO_BIN),
        () => {
          systemd.reachable = false;
        },
        () => {
          systemd.enableFails = true;
          daemonGone();
        },
        () => rmSync(WORKER),
      ];
      for (const setUp of cases) {
        rmSync(CONFIG, { recursive: true, force: true });
        vi.stubEnv("PATH", BIN);
        systemd.reachable = true;
        systemd.enableFails = false;
        writeFileSync(WORKER, "");
        daemonRunning();
        setUp();
        await autoEnableCapture({ after: "login" });
        const text = said();
        expect(text).toContain("Auto-capture is on");
        noWarning(text);
      }
    });

    it("says nothing when the file holds this key", async () => {
      saveKey(`${KEY}\n`);
      await autoEnableCapture({ after: "login" });
      const text = said();
      expect(text).toContain("Auto-capture is on");
      expect(linked()).toBe(true);
      noWarning(text);
    });
  });
});

describe("a CLI and a Node installed with brew (engram#652)", () => {
  // Homebrew on Linux keeps the layout it has on a Mac, under its own prefix:
  // each version in its keg under Cellar/, and opt/<formula> a link to the
  // current one. Its Node gives its keg as process.execPath, and a CLI
  // installed with brew runs from its own: the next `brew upgrade` removes
  // both. Links: Windows makes them only with a privilege.
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
  /** The unit the CLI brew installed writes: Node and the worker through the opt links. */
  const THROUGH_OPT: Partial<UnitPaths> = { ...OPT, path: `${dirname(OPT.node)}:/usr/local/bin:/usr/bin:/bin` };
  /** The one the same CLI wrote before engram#652: the kegs themselves. */
  const IN_KEGS: Partial<UnitPaths> = { ...KEG, path: `${dirname(KEG.node)}:/usr/local/bin:/usr/bin:/bin` };

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
    expect(readFileSync(UNIT, "utf-8")).toBe(unitWith(THROUGH_OPT));
    expect(readUnit()).toEqual({ kind: "ours", enabled: true, broken: false, version: UNIT_VERSION, outdated: false });
    expect(said()).toContain("Auto-start enabled — daemon will start when you log in (systemd)");
    expect(process.exitCode).toBeUndefined();
  });

  posixIt("finds a unit naming either keg outdated, not broken: it works only until the next upgrade", () => {
    for (const pinned of [IN_KEGS, { node: KEG.node }, { worker: KEG.worker }]) {
      writeUnit(unitWith(pinned));
      expect(readUnit()).toEqual({ kind: "ours", enabled: true, broken: false, version: UNIT_VERSION, outdated: true });
    }
    writeUnit(unitWith(THROUGH_OPT));
    expect(readUnit()).toEqual({ kind: "ours", enabled: true, broken: false, version: UNIT_VERSION, outdated: false });
  });

  posixIt("finds one naming a version the upgrade removed broken, as before; leaves a newer CLI's to it", () => {
    writeUnit(unitWith({ node: join(BREW, "Cellar", "node", "24.0.0", "bin", "node") }));
    expect(readUnit()).toEqual({ kind: "ours", enabled: true, broken: true, version: UNIT_VERSION, outdated: false });
    writeUnit(unitWith(IN_KEGS, UNIT_VERSION + 1));
    expect(readUnit()).toEqual({
      kind: "ours",
      enabled: true,
      broken: false,
      version: UNIT_VERSION + 1,
      outdated: false,
    });
  });

  posixIt("engram status says one naming the kegs is outdated, until engram install rewrites it", async () => {
    writeUnit(unitWith(IN_KEGS));
    daemonRunning();
    await daemonStatus();
    expect(said()).toContain("Auto-start: enabled (systemd)  — outdated config, run 'engram install' to update");
    await asBrewCli(() => daemonInstall());
    expect(readFileSync(UNIT, "utf-8")).toBe(unitWith(THROUGH_OPT));
    said();
    await daemonStatus();
    const after = said();
    expect(after).toContain("Auto-start: enabled (systemd)");
    expect(after).not.toMatch(/broken|outdated/);
  });

  posixIt("engram start rewrites one naming the kegs, once, and leaves it enabled", async () => {
    writeUnit(unitWith(IN_KEGS));
    await asBrewCli(() => daemonStart([], {}));
    expect(readFileSync(UNIT, "utf-8")).toBe(unitWith(THROUGH_OPT));
    expect(linked()).toBe(true);
    expect(systemctlCalls()).toEqual(["daemon-reload", ...THROUGH_SYSTEMD]);
    expect(said()).toContain(`Updated auto-start configuration (systemd unit v${UNIT_VERSION})`);
    expect(spawn).not.toHaveBeenCalled();

    // Current from then on: systemd starts the daemon from it as it is.
    daemonGone();
    execFileSync.mockClear();
    await asBrewCli(() => daemonStart([], {}));
    expect(readFileSync(UNIT, "utf-8")).toBe(unitWith(THROUGH_OPT));
    expect(systemctlCalls()).toEqual(THROUGH_SYSTEMD);
    expect(said()).not.toContain("Updated auto-start configuration");
    expect(process.exitCode).toBeUndefined();
  });

  posixIt("engram start from a CLI brew didn't install points the unit at that CLI, as with an older unit", async () => {
    writeUnit(unitWith(IN_KEGS));
    await daemonStart([], {});
    expect(readFileSync(UNIT, "utf-8")).toBe(unitWith());
    expect(said()).toContain("Updated auto-start configuration");
  });

  posixIt("leaves one the user disabled as it is", async () => {
    writeUnit(unitWith(IN_KEGS), false);
    await asBrewCli(() => daemonStart([], {}));
    expect(readFileSync(UNIT, "utf-8")).toBe(unitWith(IN_KEGS));
    expect(linked()).toBe(false);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(said()).not.toContain("Updated auto-start configuration");
  });

  posixIt("names a Node version opt/node no longer leads to as it is, and leaves that unit be", async () => {
    const ownPath: Partial<UnitPaths> = {
      node: OLDER_NODE,
      worker: OPT.worker,
      path: `${dirname(OLDER_NODE)}:/usr/local/bin:/usr/bin:/bin`,
    };
    await asBrewCli(() => daemonInstall(), OLDER_NODE);
    expect(readFileSync(UNIT, "utf-8")).toBe(unitWith(ownPath));
    expect(readUnit()).toEqual({ kind: "ours", enabled: true, broken: false, version: UNIT_VERSION, outdated: false });
    // Never rewritten again and again: what it writes reads as current.
    daemonGone();
    said();
    await asBrewCli(() => daemonStart([], {}), OLDER_NODE);
    expect(readFileSync(UNIT, "utf-8")).toBe(unitWith(ownPath));
    expect(said()).not.toContain("Updated auto-start configuration");
  });

  describe("auto-capture", () => {
    signedInAtATerminal();

    posixIt("rewrites one naming the kegs after a command, says so once, then nothing", async () => {
      writeUnit(unitWith(IN_KEGS));
      daemonRunning();
      await asBrewCli(() => autoEnableCapture({ after: "command" }));
      expect(readFileSync(UNIT, "utf-8")).toBe(unitWith(THROUGH_OPT));
      const text = said();
      expect(text).toContain("Updated auto-start configuration");
      expect(text).toContain("Auto-capture is on");

      execFileSync.mockClear();
      for (let command = 0; command < 3; command++) {
        await asBrewCli(() => autoEnableCapture({ after: "command" }));
        expect(said()).toBe("");
      }
      expect(execFileSync).not.toHaveBeenCalled();
      expect(readFileSync(UNIT, "utf-8")).toBe(unitWith(THROUGH_OPT));
    });
  });
});
