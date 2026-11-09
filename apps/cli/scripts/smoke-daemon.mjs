#!/usr/bin/env node
/**
 * Starts and stops the real daemon from the built CLI, and on Windows turns
 * start at login on and off (engram#602). The unit tests fake the registry
 * and the spawn; this runs the real thing, which is where #602's bugs were:
 * a worker path of "C:\C:\…" that failed every background start, and an
 * `install` that only knew launchd. On macOS and Linux it also checks that
 * ~/.engram and every file in it are the user's alone (engram#627), on a new
 * install and on one an older version left readable by other users.
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
const ENGRAM_DIR = join(home, ".engram");
const PID_FILE = join(ENGRAM_DIR, "daemon.pid");
const LOG_FILE = join(ENGRAM_DIR, "daemon.log");

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

const pids = new Set();
/**
 * The PID of a worker that has written its PID file and is alive. `engram
 * stop` deletes the file, so after a stop any PID here is a new worker's:
 * comparing PIDs instead would trip over Windows reusing one.
 */
async function started(what) {
  const pid = await waitFor(what, () => {
    const p = daemonPid();
    return p !== null && alive(p) ? p : null;
  });
  if (pid) pids.add(pid);
  return pid;
}
async function stopped(pid) {
  const r = engram("stop");
  check(r.status === 0, "stop exits 0");
  if (pid) await waitFor("the worker exits", () => !alive(pid));
  check(daemonPid() === null, "stop removes the PID file");
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

    check(existsSync(win32.join(SYSTEM32, "rundll32.exe")), "rundll32.exe, the URL opener, is where upgrade.ts looks");
  } else if (process.platform === "linux") {
    // install used to write a macOS plist here and run launchctl (engram#602).
    r = engram("install");
    check(r.status === 0, "install exits 0");
    check(/Start at login isn't available on Linux yet/.test(r.out), "install says what it can't do");
    check(!existsSync(join(home, "Library")), "install writes no plist");
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
} catch (err) {
  check(false, `smoke test crashed: ${err instanceof Error ? err.stack : err}`);
} finally {
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
