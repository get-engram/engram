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
 * On Windows it also checks the supervisor (engram#613): every way of
 * starting the daemon runs the worker under one, `engram stop` asks the
 * worker to stop through ~/.engram/daemon.stop and it shuts down as it does
 * for SIGTERM, a worker ended outright is started again, and one ended
 * after a stop request isn't.
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
  const r = spawnSync(node, [CLI, ...args], {
    env,
    cwd: root,
    encoding: "utf-8",
    timeout: 60_000,
    windowsHide: true,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "");
  console.log(`\n$ engram ${args.join(" ")}  (exit ${r.status ?? r.signal ?? r.error?.message})`);
  for (const line of out.trimEnd().split("\n")) console.log(`  │ ${line}`);
  return { status: r.status, out };
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
