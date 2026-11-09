import { describe, it, expect, beforeEach, afterEach, afterAll, vi, type Mock } from "vitest";
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

const { home, daemon, systemd, spawn, execSync, execFileSync } = vi.hoisted(() => ({
  home: { dir: "" },
  // What answers on the daemon's socket: a daemon, or nothing.
  daemon: { answering: null as { pid: number } | null },
  // The fake user service manager: whether it answers, and whether it
  // refuses to enable the unit.
  systemd: { reachable: true, enableFails: false },
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
vi.mock("../config.js", () => ({
  loadConfig: vi.fn(async () => ({})),
  saveConfig: vi.fn(async () => {}),
  getBaseUrl: () => "https://engram.invalid",
  resolveBaseUrl: () => "https://engram.invalid",
}));
// An install has dist/daemon/worker.js beside launch.js; under vitest the
// module beside launch.ts is worker.ts. Point at a file that exists.
vi.mock("../daemon/launch.js", async (importOriginal) => {
  const path = await import("node:path");
  return {
    ...(await importOriginal<typeof import("../daemon/launch.js")>()),
    workerPath: () => path.join(home.dir, "cli", "dist", "daemon", "worker.js"),
  };
});
// The probe answers from `daemon.answering`; the rest is the real module.
vi.mock("../daemon/instance.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../daemon/instance.js")>();
  const probeDaemon = async (): Promise<Probe> => {
    const a = daemon.answering;
    if (a === null) return { state: "none", stale: false };
    return { state: "answered", info: { ready: true, stopping: false, stopFile: false, version: real.VERSION, ...a } };
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
const { loadConfig } = await import("../config.js");
const {
  autoEnableCapture,
  daemonInstall,
  daemonStart,
  daemonStatus,
  daemonUninstall,
  repairSystemdUnitIfStale,
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

const NODE = realpathSync.native(process.execPath);
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
    default:
      throw new Error(`unexpected systemctl ${command}`);
  }
}

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

/** The daemon is gone, as after a restart. */
function daemonGone(): void {
  daemon.answering = null;
  rmSync(PID_FILE, { force: true });
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

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  systemd.reachable = true;
  systemd.enableFails = false;
  daemon.answering = null;
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
  it("writes the unit, enables it, and starts the daemon now", async () => {
    await daemonInstall();
    expect(readFileSync(UNIT, "utf-8")).toBe(unitWith());
    expect(readdirSync(UNIT_DIR).sort()).toEqual(["default.target.wants", "engram.service"]);
    expect(linked()).toBe(true);
    // Enabled, not started: systemd starts it from the next login on.
    expect(systemctlCalls()).toEqual(["show --property=Version", "daemon-reload", "enable engram.service"]);
    expect(spawn).toHaveBeenCalledTimes(1);
    const text = output();
    expect(text).toContain("Auto-start enabled — daemon will start when you log in (systemd)");
    expect(text).toContain(`Unit: ${UNIT}`);
    expect(text).toContain("Engram daemon started");
    expect(process.exitCode).toBeUndefined();
    expect(readUnit()).toEqual({ kind: "ours", enabled: true, broken: false, version: UNIT_VERSION });
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

  it("leaves a running daemon be", async () => {
    daemonRunning();
    await daemonInstall();
    expect(spawn).not.toHaveBeenCalled();
    expect(systemctlCalls()).toEqual(["show --property=Version", "daemon-reload", "enable engram.service"]);
    expect(linked()).toBe(true);
    expect(process.exitCode).toBeUndefined();
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
    daemonRunning();
    await daemonStatus();
    const text = output();
    expect(text).toContain("Auto-start: enabled (systemd)");
    expect(text).not.toContain("outdated");
    expect(text).not.toContain("broken");
    expect(execFileSync).not.toHaveBeenCalled();
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
      daemonRunning();
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
    expect(systemctlCalls()).toEqual(["daemon-reload"]);
    const text = output();
    expect(text).toContain(`Updated auto-start configuration (systemd unit v${UNIT_VERSION})`);
    expect(spawn).toHaveBeenCalledTimes(1);
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

    daemonGone();
    writeUnit("[Service]\nExecStart=/usr/bin/true\n");
    await daemonStart([], {});
    expect(readFileSync(UNIT, "utf-8")).toBe("[Service]\nExecStart=/usr/bin/true\n");
    expect(execFileSync).not.toHaveBeenCalled();
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

describe("auto-capture on Linux (engram#615)", () => {
  const realIsTTY = process.stdin.isTTY;
  const config = vi.mocked(loadConfig);

  beforeEach(() => {
    // What the test run itself sets to keep auto-capture out of other tests.
    vi.stubEnv("ENGRAM_NO_AUTOCAPTURE", "");
    vi.stubEnv("ENGRAM_API_KEY", undefined);
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    config.mockResolvedValue({ apiKey: "eng_test_615" } as never);
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: realIsTTY, configurable: true });
    config.mockReset().mockImplementation(async () => ({}) as never);
  });

  it("starts the daemon and turns on start at login after sign-in, then says nothing more", async () => {
    await autoEnableCapture({ after: "login" });
    expect(spawn).toHaveBeenCalledTimes(1);
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
    expect(spawn).toHaveBeenCalledTimes(1);
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
