#!/usr/bin/env node
/**
 * Starts and stops the real daemon from the built CLI, and on Windows turns
 * start at login on and off (engram#602). The unit tests fake the registry
 * and the spawn; this runs the real thing, which is where #602's bugs were:
 * a worker path of "C:\C:\…" that failed every background start, and an
 * `install` that only knew launchd. On macOS and Linux it also checks that
 * ~/.engram and every file in it are the user's alone (engram#627), on a new
 * install and on one an older version left readable by other users.
 * On Linux, `install` with no systemd user session says start at login
 * needs one and writes no unit (engram#615); scripts/e2e-systemd.mjs runs
 * the real systemd.
 *
 * With a config.json it can't write, `engram stop` still stops the daemon,
 * says it couldn't record that capture is off, why, and what fixes it, and
 * exits 1; once it's fixed, a stop records it (engram#681).
 *
 * On macOS and Linux, a daemon started while its log couldn't be written
 * runs without it; once the log can be written, status and start say the
 * daemon doesn't write to it, and what has it write there. A log moved or
 * deleted while the daemon runs is said too (engram#720).
 *
 * On Linux and Windows, this build copied where npx puts a package turns
 * no start at login on: `install` and `start --install` from there say how
 * to install the CLI, exit 1, and change nothing (engram#665).
 *
 * On Windows it also checks the supervisor (engram#613): every way of
 * starting the daemon runs the worker under one, `engram stop` asks the
 * worker to stop through ~/.engram/daemon.stop and it shuts down as it does
 * for SIGTERM, a worker ended outright is started again, and one ended
 * after a stop request isn't.
 *
 * On Windows, Node run from a Scoop app's `current` junction is named by it
 * in the Run entry, which outlasts the version `scoop update` and
 * `scoop cleanup` remove (engram#664): an entry naming the version reads as
 * outdated, the next start points it at `current`, and after an update and
 * a cleanup the entry still starts the daemon at sign-in. The junction is a
 * real one, which the unit tests have only where they run on Windows.
 *
 * Usage, after `pnpm build`:  node scripts/smoke-daemon.mjs
 *
 * Everything happens under a temporary home with a placeholder API key and
 * an unreachable server, so it never touches your ~/.engram or your account.
 * On Windows it does write the per-user Run entry and its Startup apps
 * switch, which have no temporary stand-in, so it refuses to run where
 * Engram's start at login is already set up, and removes both when done.
 * It never runs `install` on macOS: the launchd agent would load under the
 * same label as a real install.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const WINDOWS = process.platform === "win32";
const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const CLI = join(DIST, "index.js");
const LOGIN_START = join(DIST, "daemon", "login-start.js");

const SYSTEM32 = win32.join(process.env.SystemRoot || "C:\\Windows", "System32");
const REG = win32.join(SYSTEM32, "reg.exe");
const POWERSHELL = win32.join(SYSTEM32, "WindowsPowerShell", "v1.0", "powershell.exe");
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const APPROVED_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
const VALUE = "Engram";

if (!existsSync(CLI)) {
  console.error(`No build at ${CLI}. Run 'pnpm build' first.`);
  process.exit(1);
}

/** A registry value read without Engram's code: its string, or its bytes for REG_BINARY. */
function regValue(key, kind) {
  // PowerShell, not reg.exe, so this doesn't share a parser with the code
  // under test; base64 out, so the console's code page can't mangle it.
  const path = key.replace(/^HKCU\\/, "HKCU:\\");
  const encode =
    kind === "string" ? "[Text.Encoding]::Unicode.GetBytes([string]$v)" : "[byte[]]$v";
  const script =
    "$ProgressPreference = 'SilentlyContinue'; " +
    `$v = (Get-ItemProperty -LiteralPath '${path}' -Name '${VALUE}' -ErrorAction SilentlyContinue).'${VALUE}'; ` +
    `if ($null -ne $v) { [Convert]::ToBase64String(${encode}) }`;
  const out = execFileSync(
    POWERSHELL,
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf-8", windowsHide: true },
  ).trim();
  if (!out) return null;
  const bytes = Buffer.from(out, "base64");
  return kind === "string" ? bytes.toString("utf16le") : bytes;
}

if (WINDOWS && regValue(RUN_KEY, "string") !== null) {
  console.error(
    `${RUN_KEY}\\${VALUE} already exists. This test replaces and then deletes it,\n` +
      "so it only runs where Engram's start at login isn't set up (a CI runner).",
  );
  process.exit(1);
}

// A home with a space and letters outside ASCII, where a percent-encoded or
// code-page-mangled path breaks; on Windows, Node runs from such a folder
// too, so the Run entry has one in its command line.
const root = mkdtempSync(join(tmpdir(), "engram-smoke-"));
const home = join(root, "Ana María");
mkdirSync(join(home, ".claude", "projects"), { recursive: true });
let node = process.execPath;
if (WINDOWS) {
  const dir = join(root, "nodé ñ");
  mkdirSync(dir);
  node = join(dir, "node.exe");
  copyFileSync(process.execPath, node);
}
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  ENGRAM_API_KEY: "eng_smoke_not_a_real_key",
  ENGRAM_BASE_URL: "http://127.0.0.1:9",
  ENGRAM_NO_AUTOCAPTURE: "1",
};
// Linux: no systemd user session, whatever this machine has (engram#615).
// First on PATH, a systemctl that fails as it does then, and logs how it was
// run; a unit would go under a temporary XDG_CONFIG_HOME.
const SYSTEMCTL_CALLS = join(root, "systemctl.calls");
if (process.platform === "linux") {
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "systemctl"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >>"$ENGRAM_SMOKE_SYSTEMCTL_CALLS"\n` +
      `echo "Failed to connect to bus: No medium found" >&2\nexit 1\n`,
    { mode: 0o755 },
  );
  env.PATH = `${bin}:${env.PATH ?? ""}`;
  env.XDG_CONFIG_HOME = join(root, "config");
  env.ENGRAM_SMOKE_SYSTEMCTL_CALLS = SYSTEMCTL_CALLS;
  delete env.XDG_RUNTIME_DIR;
  delete env.DBUS_SESSION_BUS_ADDRESS;
}

const ENGRAM_DIR = join(home, ".engram");
const PID_FILE = join(ENGRAM_DIR, "daemon.pid");
const LOG_FILE = join(ENGRAM_DIR, "daemon.log");
const STOP_FILE = join(ENGRAM_DIR, "daemon.stop");

// The usual umask, whatever this shell's is: under it, what the CLI and the
// daemon create is readable by other users unless they say otherwise
// (engram#627). They inherit it from this process.
if (!WINDOWS) process.umask(0o022);

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) failures++;
  return ok;
}

/**
 * Run the built CLI as a user would; colours stripped from the output.
 * Most checks use `daemon status`, the daemon alone. `engram status` also
 * asks the server for usage, which is unreachable here (engram#609).
 */
function engram(...args) {
  return engramAt(CLI, ...args);
}

/** engram(), with the CLI at `cli`. */
function engramAt(cli, ...args) {
  return runEngram(node, cli, args);
}

/** engram(), run by the Node at `by` (engram#664). */
function engramBy(by, ...args) {
  return runEngram(by, CLI, args);
}

function runEngram(by, cli, args) {
  const r = spawnSync(by, [cli, ...args], {
    env,
    cwd: root,
    encoding: "utf-8",
    timeout: 60_000,
    windowsHide: true,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "");
  const nodeSaid = by === node ? "" : `  by ${by}`;
  console.log(`\n$ engram ${args.join(" ")}  (exit ${r.status ?? r.signal ?? r.error?.message})${nodeSaid}`);
  for (const line of out.trimEnd().split("\n")) console.log(`  │ ${line}`);
  return { status: r.status, out };
}

/**
 * This build where npx puts a package (engram#665),
 * <npm cache>/_npx/<hash>/node_modules/@getengram/cli, its dependencies
 * linked in: its CLI.
 */
function npxCopy() {
  const pkg = join(root, "npm-cache", "_npx", "f3920abdac2db749", "node_modules", "@getengram", "cli");
  const copy = (from, to) => {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (entry.isDirectory()) copy(join(from, entry.name), join(to, entry.name));
      else copyFileSync(join(from, entry.name), join(to, entry.name));
    }
  };
  copy(DIST, join(pkg, "dist"));
  copyFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), join(pkg, "package.json"));
  const deps = realpathSync(fileURLToPath(new URL("../node_modules", import.meta.url)));
  symlinkSync(deps, join(pkg, "node_modules"), WINDOWS ? "junction" : "dir");
  return join(pkg, "dist", "index.js");
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function daemonPid() {
  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/** The daemon's log so far: the worker's lines, and on Windows the supervisor's. */
function readLog() {
  try {
    return readFileSync(LOG_FILE, "utf-8");
  } catch {
    return "";
  }
}

/** A process's parent PID and command line, read without Engram's code (Windows); null when it isn't running. */
function processInfo(pid) {
  const script =
    "$ProgressPreference = 'SilentlyContinue'; " +
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}'; ` +
    "if ($p) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(" +
    "(@{ parent = [int]$p.ParentProcessId; cmd = [string]$p.CommandLine } | ConvertTo-Json -Compress))) }";
  const out = execFileSync(
    POWERSHELL,
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf-8", windowsHide: true },
  ).trim();
  return out ? JSON.parse(Buffer.from(out, "base64").toString("utf-8")) : null;
}

/** Whether `pid` is still one of the supervisors this test started, and not a process Windows has given its PID since. */
function isSupervisor(pid) {
  try {
    return /supervisor\.js/.test(processInfo(pid)?.cmd ?? "");
  } catch {
    return false;
  }
}

async function waitFor(what, test, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = test();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
  check(false, `${what} (gave up after ${ms / 1000}s)`);
  return null;
}

function reg(...args) {
  try {
    execFileSync(REG, args, { stdio: "ignore", windowsHide: true });
  } catch {
    // not there
  }
}

/** check(), for something that should come true within `ms`. */
async function soon(what, test, ms) {
  const value = await waitFor(what, test, ms);
  if (value) check(true, what);
  return value;
}

const pids = new Set();
/** On Windows, the supervisors seen, by their PIDs (engram#613): ended before the workers when the test ends. */
const supervisors = new Set();
/** Worker PID → the supervisor that started it: { pid, cmd }. */
const supervisorFor = new Map();

/**
 * The PID of a worker that has written its PID file and is alive (and isn't
 * `not`, one ended outright, whose PID file stays). `engram stop` deletes the
 * file, so after a stop any PID here is a new worker's: comparing PIDs
 * instead would trip over Windows reusing one. On Windows, the worker must
 * have been started by a supervisor (engram#613).
 */
async function started(what, not = null) {
  const pid = await waitFor(what, () => {
    const p = daemonPid();
    return p !== null && p !== not && alive(p) ? p : null;
  });
  if (pid) pids.add(pid);
  if (pid && WINDOWS) {
    const worker = processInfo(pid);
    const parent = worker ? processInfo(worker.parent) : null;
    if (check(/supervisor\.js/.test(parent?.cmd ?? ""), `${what}: under a supervisor (${parent?.cmd ?? "none"})`)) {
      supervisors.add(worker.parent);
      supervisorFor.set(pid, { pid: worker.parent, cmd: parent.cmd });
    }
  }
  return pid;
}

/** `engram stop`, with the daemon running as `pid`: exits `exit`, and the daemon is gone. */
async function stopped(pid, exit = 0) {
  const running = pid !== null && alive(pid);
  const supervisor = running ? supervisorFor.get(pid) : undefined;
  if (WINDOWS && supervisor) {
    // From this line on it shuts down for a stop as for SIGTERM. Asked
    // before, it exits at once, cleanly, with nothing yet to finish.
    await waitFor("the worker is set up", () => readLog().includes(`daemon started (pid ${pid})`));
  }
  const logFrom = readLog().length;
  const r = engram("stop");
  check(r.status === exit, `stop exits ${exit}`);
  if (pid) await waitFor("the worker exits", () => !alive(pid));
  check(daemonPid() === null, "stop removes the PID file");
  if (WINDOWS && supervisor) {
    // Asked through the stop file, not ended outright (engram#613).
    check(!/didn't take the request|ended outright/.test(r.out), "the worker takes the request to stop");
    check(
      /stop requested \('engram stop'\)[\s\S]*daemon stopped/.test(readLog().slice(logFrom)),
      "the worker shuts down as it does for SIGTERM",
    );
    if (await soon("its supervisor exits", () => !alive(supervisor.pid), 15_000)) supervisors.delete(supervisor.pid);
    check(!/supervisor: /.test(readLog().slice(logFrom)), "and doesn't start it again");
    check(!existsSync(STOP_FILE), "the worker removes the request once it has stopped");
  }
  return r;
}

/** Permission bits, in octal. */
function modeOf(path) {
  return (statSync(path).mode & 0o777).toString(8);
}

/**
 * What the daemon keeps in ~/.engram while it runs: the CLI's config, the
 * log, the PID file, status.json, and the queue of transcript text with
 * SQLite's -wal and -shm files beside it.
 */
const DAEMON_FILES = ["config.json", "daemon.log", "daemon.pid", "status.json", "daemon.db", "daemon.db-wal", "daemon.db-shm"];

async function daemonFiles() {
  await waitFor("the daemon's files are all there", () =>
    DAEMON_FILES.every((name) => existsSync(join(ENGRAM_DIR, name))),
  );
}

/** ~/.engram is 0700 and every regular file in it 0600 (engram#627). Returns the files' names. */
function checkPrivate(when) {
  const dirMode = modeOf(ENGRAM_DIR);
  check(dirMode === "700", `${when}: ~/.engram is 0700 (it is ${dirMode})`);
  const files = [];
  const open = [];
  for (const name of readdirSync(ENGRAM_DIR).sort()) {
    let st;
    try {
      st = lstatSync(join(ENGRAM_DIR, name));
    } catch {
      continue; // a temp file of status.json's, renamed since the listing
    }
    if (!st.isFile()) continue;
    files.push(name);
    const mode = (st.mode & 0o777).toString(8);
    if (mode !== "600") open.push(`${name} is ${mode}`);
  }
  check(
    open.length === 0,
    `${when}: every file in ~/.engram is 0600 (${open.length > 0 ? open.join(", ") : files.join(", ")})`,
  );
  return files;
}

try {
  // ── from npx's cache, no start at login (engram#665) ──
  // Not on macOS, where this never runs `install` (see above).
  if (process.platform !== "darwin") {
    const npxCli = npxCopy();
    for (const args of [["install"], ["start", "--install"]]) {
      const r = engramAt(npxCli, ...args);
      const what = `${args.join(" ")} from npx's cache`;
      check(r.status === 1, `${what} exits 1`);
      check(
        r.out.includes("Can't turn on start at login: this Engram runs from npx's cache, which can be cleared at any time."),
        `${what} says it can't turn on start at login from there`,
      );
      check(r.out.includes("Install the CLI with: npm install -g @getengram/cli"), `${what} says how to install the CLI`);
    }
    await new Promise((res) => setTimeout(res, 1_000));
    check(daemonPid() === null, "from npx's cache, neither starts the daemon");
    if (WINDOWS) check(regValue(RUN_KEY, "string") === null, "from npx's cache, neither adds the Run entry");
    else {
      check(!existsSync(SYSTEMCTL_CALLS), "from npx's cache, neither runs systemctl");
      check(!existsSync(join(env.XDG_CONFIG_HOME, "systemd")), "from npx's cache, neither writes a unit");
    }
  }

  // ── engram start: the background start #602 reported broken ──
  let r = engram("start");
  check(r.status === 0, "start exits 0");
  check(/Engram daemon (started|is starting)/.test(r.out), "start says the daemon started");
  let pid = await started("the worker writes its PID file");
  if (WINDOWS) {
    check(
      /--report-until=\d+/.test(supervisorFor.get(pid)?.cmd ?? ""),
      "start waits on the first worker: it reports one that can't start (engram#613)",
    );
  }
  check(!existsSync(join(home, "Library")), "nothing launchd-shaped is written");
  r = engram("daemon", "status");
  check(/Status: running/.test(r.out), "status says running");
  // It writes to its log, or on Windows doesn't say where it writes (engram#720).
  check(r.out.split("\n").includes(`Log: ${LOG_FILE}`), "status says where the log is, and nothing more of it");

  // ── engram status: the daemon, then usage, with the API unreachable (engram#609) ──
  r = engram("status");
  check(r.status === 0, "engram status exits 0 offline");
  check(/Status: running/.test(r.out), "engram status shows the daemon");
  check(/Plan and usage: couldn't reach/.test(r.out), "engram status says usage is unreachable, in one line");

  if (WINDOWS) {
    // ── engram start --install, the command in the report ──
    await stopped(pid);
    r = engram("start", "--install");
    check(r.status === 0, "start --install exits 0");
    check(/Engram daemon (started|is starting)/.test(r.out), "start --install starts the daemon");
    check(/Auto-start enabled/.test(r.out), "start --install turns on start at login");
    pid = await started("start --install starts a worker");
    const entry = regValue(RUN_KEY, "string");
    const expected = `"${realpathSync.native(node)}" "${LOGIN_START}"`;
    check(entry === expected, `the Run entry is ${expected} (got ${JSON.stringify(entry)})`);
    r = engram("daemon", "status");
    check(/Auto-start: enabled \(Windows sign-in\)/.test(r.out), "status says start at login is on");
    check(!/broken/.test(r.out), "status reads the entry as working, non-ASCII path and all");

    // ── switched off under Settings > Startup apps ──
    execFileSync(REG, ["add", APPROVED_KEY, "/v", VALUE, "/t", "REG_BINARY", "/d", "03000000d07a1b9c2f4edc01", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    r = engram("daemon", "status");
    check(/switched off in Windows Startup apps/.test(r.out), "status sees the Startup apps switch-off");
    r = engram("install");
    check(r.status === 0, "install exits 0");
    check(regValue(APPROVED_KEY, "binary") === null, "install turns it back on");
    r = engram("daemon", "status");
    check(/Auto-start: enabled \(Windows sign-in\)/.test(r.out), "status says on again");

    // ── sign-in: run the entry's command line the way Windows does ──
    await stopped(pid);
    const signIn = spawnSync(entry ?? expected, { shell: true, stdio: "ignore", env, timeout: 60_000, windowsHide: true });
    check(signIn.status === 0, "the sign-in entry runs and exits");
    pid = await started("the sign-in entry starts a worker");
    check(
      !/--report-until/.test(supervisorFor.get(pid)?.cmd ?? "--report-until"),
      "at sign-in nothing waits on the worker: the supervisor starts it again whatever it exits with",
    );
    r = engram("daemon", "status");
    check(/Status: running/.test(r.out), "status says running after sign-in");

    // ── asking again while it runs starts no second worker ──
    r = engram("start", "--install");
    check(/already running/.test(r.out), "start --install sees the running daemon");
    check(/Auto-start enabled/.test(r.out), "start --install still turns on start at login");
    r = engram("start");
    check(!/Updated the start-at-login entry/.test(r.out), "start leaves a working entry alone");
    await new Promise((res) => setTimeout(res, 2_000));
    check(daemonPid() === pid && alive(pid), "still the one worker");

    // ── engram uninstall ──
    r = engram("uninstall");
    check(r.status === 0, "uninstall exits 0");
    check(/Auto-start disabled/.test(r.out), "uninstall says start at login is off");
    check(regValue(RUN_KEY, "string") === null, "the Run entry is gone");
    check(alive(pid), "the daemon keeps running");

    // ── engram install with the daemon stopped starts it too ──
    await stopped(pid);
    r = engram("install");
    check(r.status === 0, "install exits 0");
    check(/Auto-start enabled/.test(r.out), "install turns on start at login");
    check(/Engram daemon (started|is starting)/.test(r.out), "install starts the daemon");
    pid = await started("install starts a worker");
    r = engram("uninstall");
    check(regValue(RUN_KEY, "string") === null, "uninstall removes it again");

    // ── a worker ended outright is started again (engram#613) ──
    // process.kill is TerminateProcess here: no handler runs, as in a crash.
    const supervisor = supervisorFor.get(pid);
    if (check(pid !== null && supervisor !== undefined, "a worker under a supervisor to end")) {
      let logFrom = readLog().length;
      const crashed = pid;
      process.kill(crashed);
      pid = await started("the supervisor starts the worker again after a crash", crashed);
      check(pid !== null && supervisorFor.get(pid)?.pid === supervisor.pid, "the same supervisor");
      check(
        /supervisor: the daemon exited with code 1; starting it again in 10s/.test(readLog().slice(logFrom)),
        "the supervisor's log says so",
      );

      // ── …and one ended after a stop request isn't ──
      // As when `engram stop` ends a worker that didn't take its request (one
      // from before #613). This request names another process, so the worker
      // leaves it be.
      if (pid !== null) {
        logFrom = readLog().length;
        writeFileSync(STOP_FILE, `${JSON.stringify({ pid: process.pid, id: "0".repeat(32) })}\n`);
        await new Promise((res) => setTimeout(res, 2_500));
        check(
          alive(pid) && !/stop requested/.test(readLog().slice(logFrom)),
          "the worker leaves a request for another process alone",
        );
        process.kill(pid);
        if (await soon("the supervisor exits", () => !alive(supervisor.pid), 15_000)) supervisors.delete(supervisor.pid);
        check(
          /supervisor: stopped by 'engram stop'; not starting it again/.test(readLog().slice(logFrom)),
          "the supervisor's log says it wasn't started again, and why",
        );
        check(!existsSync(STOP_FILE), "the supervisor removes the request");
      }
    }

    // ── Node from Scoop, by its current junction (engram#664) ──
    // Scoop keeps each version of an app in a folder of its own, and
    // `current`, a junction to the one in use: `scoop update` points it at
    // the new version and `scoop cleanup` removes the old one. Windows
    // resolves the junction in Node's own path, so the entry named the
    // version, and stopped starting the daemon at sign-in after a cleanup.
    // Under the home, where Scoop keeps its apps.
    const APP = join(home, "scoop", "apps", "nodejs");
    const scoopNode = (version) => join(APP, version, "node.exe");
    /** This Node, as a version of the app. */
    const addVersion = (version) => {
      mkdirSync(join(APP, version), { recursive: true });
      copyFileSync(process.execPath, scoopNode(version));
    };
    /** Point current at the version, as `scoop update` does. */
    const pointCurrent = (version) => {
      rmSync(join(APP, "current"), { force: true }); // the junction, not the version it leads to
      symlinkSync(join(APP, version), join(APP, "current"), "junction");
    };
    const BY_CURRENT = scoopNode("current");
    // By its real path, as the CLI names Node: the runner's temp folder is
    // an 8.3 short name.
    const scoopEntry = (version) => `"${join(realpathSync.native(APP), version, "node.exe")}" "${LOGIN_START}"`;
    addVersion("22.11.0");
    pointCurrent("22.11.0");

    // None running: start repairs the entry only then, and the version
    // folder is removed below, which Windows refuses while a program in it
    // runs. The worker ended outright above left its PID file.
    const ended = daemonPid();
    if (ended !== null && pids.has(ended) && alive(ended)) await stopped(ended);

    r = engramBy(BY_CURRENT, "install");
    check(r.status === 0, "install from Scoop's Node exits 0");
    pid = await started("install from Scoop's Node starts a worker", ended);
    let scoopNow = regValue(RUN_KEY, "string");
    check(
      scoopNow === scoopEntry("current"),
      `the Run entry names Node by Scoop's current junction: ${scoopEntry("current")} (got ${JSON.stringify(scoopNow)})`,
    );
    r = engramBy(BY_CURRENT, "daemon", "status");
    check(
      /Auto-start: enabled \(Windows sign-in\)/.test(r.out) && !/broken|outdated/.test(r.out),
      "status reads that entry as working and up to date",
    );
    await stopped(pid);

    // The entry a CLI from before #664 wrote: Node by its version.
    execFileSync(REG, ["add", RUN_KEY, "/v", VALUE, "/t", "REG_SZ", "/d", scoopEntry("22.11.0"), "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    check(regValue(RUN_KEY, "string") === scoopEntry("22.11.0"), "an entry naming Scoop's version, as before #664");
    r = engramBy(BY_CURRENT, "daemon", "status");
    check(/outdated config/.test(r.out) && !/broken/.test(r.out), "status says that entry is outdated");
    r = engramBy(BY_CURRENT, "start");
    check(r.status === 0, "start from Scoop's Node exits 0");
    check(
      r.out.split("\n").filter((line) => line.includes("Updated the start-at-login entry")).length === 1,
      "start says it updated the entry, once",
    );
    pid = await started("start from Scoop's Node starts a worker");
    scoopNow = regValue(RUN_KEY, "string");
    check(scoopNow === scoopEntry("current"), `start points it at current (got ${JSON.stringify(scoopNow)})`);
    r = engramBy(BY_CURRENT, "daemon", "status");
    check(!/broken|outdated/.test(r.out), "and status reads it as up to date: nothing rewrites it again");
    await stopped(pid);

    // scoop update nodejs, then scoop cleanup nodejs.
    addVersion("23.1.0");
    pointCurrent("23.1.0");
    rmSync(join(APP, "22.11.0"), { recursive: true, maxRetries: 10, retryDelay: 500 });
    check(!existsSync(scoopNode("22.11.0")), "the cleanup removes the version the entry used to name");
    r = engramBy(BY_CURRENT, "daemon", "status");
    check(
      /Auto-start: enabled \(Windows sign-in\)/.test(r.out) && !/broken|outdated/.test(r.out),
      "after the update and the cleanup, status reads the entry as working",
    );
    scoopNow = regValue(RUN_KEY, "string");
    check(scoopNow === scoopEntry("current"), "the entry is unchanged");
    const signInAfterUpdate = spawnSync(scoopNow ?? scoopEntry("current"), {
      shell: true,
      stdio: "ignore",
      env,
      timeout: 60_000,
      windowsHide: true,
    });
    check(signInAfterUpdate.status === 0, "the entry runs at sign-in after the update");
    pid = await started("and starts a worker, on the new version");
    await stopped(pid);
    r = engram("uninstall");
    check(regValue(RUN_KEY, "string") === null, "uninstall removes the entry");

    check(existsSync(win32.join(SYSTEM32, "rundll32.exe")), "rundll32.exe, the URL opener, is where upgrade.ts looks");
  } else if (process.platform === "linux") {
    // install used to write a macOS plist here and run launchctl (engram#602).
    // With no systemd user session it writes no unit either (engram#615).
    r = engram("install");
    check(r.status === 0, "install exits 0");
    check(
      /Start at login isn't available here: it needs a systemd user session/.test(r.out),
      "install says start at login needs a systemd user session",
    );
    check(/keeps running until you sign out or restart/.test(r.out), "and that the daemon runs until then");
    check(!existsSync(join(env.XDG_CONFIG_HOME, "systemd")), "install writes no systemd unit");
    check(!existsSync(join(home, ".config")), "nor anything under ~/.config");
    check(!existsSync(join(home, "Library")), "install writes no plist");
    check(
      existsSync(SYSTEMCTL_CALLS) && readFileSync(SYSTEMCTL_CALLS, "utf-8") === "--user show --property=Version\n",
      "install only asks systemctl --user whether a service manager answers",
    );
    r = engram("uninstall");
    check(r.status === 0 && /Auto-start isn't on/.test(r.out), "uninstall says auto-start isn't on");
    check(alive(daemonPid()), "the daemon keeps running");
  }

  let freshTemp = null;
  if (!WINDOWS) {
    // ── ~/.engram is the user's alone (engram#627) ──
    // A new install, made by the start above under the usual umask.
    await daemonFiles();
    checkPrivate("a new install");

    // An install from before the fix: the folder 0755 and the files in it
    // 0644. Beside them, what the start must clean up or leave alone: a temp
    // file an interrupted write left an hour ago (removed), one a write in
    // progress could have now (kept), a file that isn't the daemon's (made
    // private too), and a symlink to a file outside ~/.engram and a folder
    // inside it (neither changed).
    await stopped(daemonPid());
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "not Engram's\n");
    writeFileSync(join(ENGRAM_DIR, "notes.txt"), "not the daemon's\n");
    const staleTemp = join(ENGRAM_DIR, "status.json.99999.deadbeef.tmp");
    freshTemp = join(ENGRAM_DIR, "config.json.99999.cafef00d.tmp");
    writeFileSync(staleTemp, "{");
    writeFileSync(freshTemp, "{");
    const anHourAgo = Date.now() / 1000 - 3600;
    utimesSync(staleTemp, anHourAgo, anHourAgo);
    symlinkSync(outside, join(ENGRAM_DIR, "outside-link"));
    mkdirSync(join(ENGRAM_DIR, "folder"));
    writeFileSync(join(ENGRAM_DIR, "folder", "inside.txt"), "left as it is\n");
    for (const name of readdirSync(ENGRAM_DIR)) {
      const path = join(ENGRAM_DIR, name);
      const st = lstatSync(path);
      if (!st.isSymbolicLink()) chmodSync(path, st.isDirectory() ? 0o755 : 0o644);
    }
    chmodSync(join(ENGRAM_DIR, "folder", "inside.txt"), 0o644);
    chmodSync(outside, 0o644);
    chmodSync(ENGRAM_DIR, 0o755);

    r = engram("start");
    check(r.status === 0, "start exits 0 on an install from before the fix");
    await started("the worker starts on it");
    await daemonFiles();
    checkPrivate("an install from before the fix");
    check(!existsSync(staleTemp), "the start removes the temp file an interrupted write left");
    check(existsSync(freshTemp), "and keeps the one a write in progress could have");
    check(
      readlinkSync(join(ENGRAM_DIR, "outside-link")) === outside && modeOf(outside) === "644",
      "a file outside ~/.engram, linked from it, is left as it was",
    );
    check(
      modeOf(join(ENGRAM_DIR, "folder")) === "755" && modeOf(join(ENGRAM_DIR, "folder", "inside.txt")) === "644",
      "a folder in ~/.engram is left as it was",
    );
    const log = readFileSync(LOG_FILE, "utf-8");
    check(/made ~\/\.engram private: set .*notes\.txt/.test(log), "the log says which files the start made private");
    check(/removed 1 temp file/.test(log), "and that it removed the temp file");
  }

  // ── engram stop ──
  await stopped(daemonPid());
  r = engram("daemon", "status");
  check(/Status: stopped/.test(r.out), "status says stopped");
  if (!WINDOWS) {
    const files = checkPrivate("after stop");
    const temps = files.filter((name) => name.endsWith(".tmp"));
    check(
      temps.length === 1 && join(ENGRAM_DIR, temps[0]) === freshTemp,
      `the CLI's and the daemon's writes leave no temp file behind (${temps.join(", ")})`,
    );
  }

  // ── engram stop with a config.json it can't write (engram#681) ──
  // It stops the daemon all the same. Until "off" is recorded, the next
  // engram command starts the daemon again, so it says so, and exits 1.
  r = engram("start");
  check(r.status === 0, "start exits 0");
  pid = await started("the worker starts again");
  const CONFIG = join(ENGRAM_DIR, "config.json");
  const config = readFileSync(CONFIG, "utf-8");
  check(JSON.parse(config).autocapture === "on", "start records that capture is on");
  chmodSync(CONFIG, 0o400);
  r = await stopped(pid, 1);
  const said = [
    "Couldn't record that capture is off: ~/.engram/config.json can't be written: permission denied.",
    // chmod is no fix on Windows, where a read-only file is one by an attribute.
    ...(WINDOWS
      ? ["  Once it's fixed, run 'engram stop' again, or the next engram command turns capture back on."]
      : [
          "  To fix it, run: chmod u+w ~/.engram/config.json",
          "  Then run 'engram stop' again, or the next engram command turns capture back on.",
        ]),
  ].join("\n");
  check(r.out.includes(said), "stop says it couldn't record that capture is off, why, and what fixes it");
  check(readFileSync(CONFIG, "utf-8") === config, "config.json is as it was");
  check(
    readdirSync(ENGRAM_DIR).every((name) => !name.endsWith(".tmp") || join(ENGRAM_DIR, name) === freshTemp),
    "the failed write leaves no temp file",
  );
  chmodSync(CONFIG, 0o600);
  r = engram("stop");
  check(r.status === 0 && /Daemon is not running/.test(r.out), "once it's fixed, stop exits 0");
  check(JSON.parse(readFileSync(CONFIG, "utf-8")).autocapture === "off", "and records that capture is off");

  // ── a daemon that doesn't write to its log (engram#720) ──
  // Started while its log can't be written, the daemon runs with its output
  // dropped (engram#679). It says where its output goes each time it's
  // asked, over its socket; a home whose socket path would be too long has
  // none (see daemonEndpoint), and on Windows it doesn't say.
  const SOCKET = join(ENGRAM_DIR, "daemon.sock");
  const socketFits = Buffer.byteLength(SOCKET) <= (process.platform === "linux" ? 107 : 103);
  if (!WINDOWS && !socketFits) console.log(`\n(skipped engram#720: ${SOCKET} is too long for a socket here)`);
  if (!WINDOWS && socketFits) {
    const NOT_THE_LOG = `Log: ${LOG_FILE}, but the daemon doesn't write to it:`;
    const RESTART = "  'engram stop' and then 'engram start' have the daemon write to it.";
    chmodSync(LOG_FILE, 0o400);
    r = engram("start");
    check(r.status === 0, "start exits 0 while the log can't be written");
    check(
      r.out.includes(`Log: ${LOG_FILE} can't be written (EACCES), so the daemon runs without it.`),
      "start says the daemon runs without its log",
    );
    pid = await started("the worker starts without its log");
    await soon("the daemon answers on its socket", () => existsSync(SOCKET), 15_000);
    const before = readFileSync(LOG_FILE, "utf-8");

    chmodSync(LOG_FILE, 0o600);
    r = engram("daemon", "status");
    check(
      r.out.includes(`${NOT_THE_LOG} it started without it.\n${RESTART}`),
      "once the log can be written, status says the daemon doesn't write to it, and what has it write there",
    );
    check(!/can't be written|journal/.test(r.out), "and nothing of a log that can't be written, or a journal");
    r = engram("start");
    check(/Daemon already running/.test(r.out), "start finds it running");
    check(r.out.includes(`${NOT_THE_LOG} it started without it.\n${RESTART}`), "and says it doesn't write to the log");
    check(readFileSync(LOG_FILE, "utf-8") === before, "it doesn't: nothing it says reaches the log");

    await stopped(pid);
    r = engram("start");
    check(r.status === 0 && r.out.split("\n").includes(`Log: ${LOG_FILE}`), "a start once it can be written has it write there");
    pid = await started("the worker starts with its log");
    await soon("the daemon writes to its log", () => readLog().includes(`daemon started (pid ${pid})`));
    r = engram("daemon", "status");
    check(
      r.out.split("\n").includes(`Log: ${LOG_FILE}`) && !r.out.includes(NOT_THE_LOG),
      "status says where the log is, and nothing more of it",
    );

    // The log moved, as a log rotation does without telling the daemon,
    // then deleted, while it runs.
    renameSync(LOG_FILE, `${LOG_FILE}.1`);
    r = engram("daemon", "status");
    check(r.out.includes(`${NOT_THE_LOG} it writes to another file.\n${RESTART}`), "a log moved away: it writes to another file");
    rmSync(`${LOG_FILE}.1`);
    r = engram("daemon", "status");
    check(
      r.out.includes(`${NOT_THE_LOG} the log it writes to has been deleted or replaced.\n${RESTART}`),
      "a log deleted: the log it writes to has been deleted or replaced",
    );
    check(!existsSync(LOG_FILE), "status makes no log");
    await stopped(pid);
    r = engram("start");
    pid = await started("the worker starts again");
    r = engram("daemon", "status");
    check(
      r.out.split("\n").includes(`Log: ${LOG_FILE}`) && !r.out.includes(NOT_THE_LOG),
      "after a stop and a start it writes to the log again",
    );
    await stopped(pid);
  }
} catch (err) {
  check(false, `smoke test crashed: ${err instanceof Error ? err.stack : err}`);
} finally {
  // Supervisors first: one would start its worker again.
  for (const pid of supervisors) {
    if (alive(pid) && isSupervisor(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone
      }
    }
  }
  const left = daemonPid();
  if (left !== null) pids.add(left);
  for (const pid of pids) {
    if (alive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone
      }
    }
  }
  if (WINDOWS) {
    reg("delete", RUN_KEY, "/v", VALUE, "/f");
    reg("delete", APPROVED_KEY, "/v", VALUE, "/f");
  }
  if (existsSync(LOG_FILE)) {
    console.log("\ndaemon.log:");
    for (const line of readFileSync(LOG_FILE, "utf-8").trimEnd().split("\n")) console.log(`  │ ${line}`);
  }
  // The killed worker can hold its files open for a moment on Windows.
  await new Promise((r) => setTimeout(r, 1_000));
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (err) {
    console.log(`(couldn't remove ${root}: ${err instanceof Error ? err.message : err})`);
  }
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
