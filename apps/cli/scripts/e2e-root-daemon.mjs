#!/usr/bin/env node
/**
 * A daemon left running as root (engram#680), with real root, through sudo.
 * Before engram#653, `sudo engram start` started the daemon as root, and
 * `sudo engram install` loaded its launchd job into the system domain,
 * where it runs as root. The unit tests check what the CLI says of made-up
 * processes; this runs real ones as root, under a temporary home, and
 * checks:
 *
 *   - A daemon running as root that the PID file names (a stand-in for one
 *     from before engram#653: it writes the PID file and status.json, as
 *     root, as that daemon did): `engram status` says it runs as root, how
 *     to stop it, and whose files are root's, and exits 0. `engram start`,
 *     `engram stop` and `engram install` say so too, exit 1, start no
 *     daemon, and write no plist or unit. Another command's banner says it.
 *     Its PID file is kept.
 *   - The worker, started as the user while it runs, exits 0 and leaves no
 *     socket; started as root with sudo, it won't run, exits 0, and makes
 *     no file.
 *   - Stopped with the command status gave, it is gone, and its PID file
 *     with it; status then says only that status.json is root's.
 *   - One whose PID file a CLI from before this change removed: status and
 *     stop name it from the process list, with the command that stops it.
 *   - Once the files are the user's again, with the command status gave,
 *     nothing is said of them, and the user's own daemon starts and stops.
 *   - macOS: a job loaded into launchd's system domain from the user's own
 *     plist, as `sudo engram install` did, running the stand-in, its PID
 *     file gone: status names it and says to unload the job; start, stop
 *     and install exit 1 and leave the plist as it is. Unloaded as told, it
 *     is gone.
 *   - macOS: that job running this build's worker: the worker won't run as
 *     root and exits 0, so launchd doesn't start it again, and it makes no
 *     file. Status says the job is still loaded, and how to unload it; the
 *     user's own daemon starts beside it.
 *   - Commands run with sudo (engram#682), HOME the user's as macOS sudo
 *     keeps it: each but help and version says to run it as yourself and
 *     exits 1. Help and version print only themselves. None of them makes
 *     or changes a file in ~/.engram, or runs launchctl or systemctl.
 *   - Through all of it, the CLI only looks at launchd and systemd:
 *     `launchctl print`, `list` and `print-disabled`, `systemctl show`.
 *
 * Usage, on a Linux or macOS CI runner with sudo that needs no password,
 * after `pnpm build`:
 *
 *   ENGRAM_E2E_ROOT=1 node scripts/e2e-root-daemon.mjs
 *
 * It runs processes as root with sudo and, on macOS, loads a job into
 * launchd's system domain under the label a real install uses, so it runs
 * only when asked to and only where CI=true. It refuses if a worker runs as
 * root already, or, on macOS, if that label is loaded. Everything runs
 * signed out, under a temporary home, with a server address nothing
 * answers on. It signals only processes it started.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync,
  realpathSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.ENGRAM_E2E_ROOT !== "1") {
  console.log("skipped: set ENGRAM_E2E_ROOT=1 to run it (CI only: it runs processes as root with sudo)");
  process.exit(0);
}
if (process.platform === "win32" || process.env.CI !== "true") {
  console.error(
    "refusing: this runs processes as root with sudo, and on macOS loads a job into launchd's system domain, " +
      "so it runs only on a Linux or macOS CI runner (CI=true)",
  );
  process.exit(1);
}
if (process.getuid() === 0) {
  console.error("refusing: run it as a user who isn't root: it checks what that user is told of a daemon running as root");
  process.exit(1);
}
const SUDO = "/usr/bin/sudo";
if (spawnSync(SUDO, ["-n", "true"], { stdio: "ignore", timeout: 30_000 }).status !== 0) {
  console.error("refusing: this needs sudo that asks for no password (sudo -n)");
  process.exit(1);
}

const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const BUILT_WORKER = fileURLToPath(new URL("../dist/daemon/worker.js", import.meta.url));
if (!existsSync(CLI) || !existsSync(BUILT_WORKER)) {
  console.error(`no build at ${CLI}: run 'pnpm build' first`);
  process.exit(2);
}
// The CLI names the worker by its module's URL, which Node gives with any
// links resolved.
const WORKER = realpathSync(BUILT_WORKER);
const NODE = process.execPath;
const MAC = process.platform === "darwin";
const UID = process.getuid();
const LABEL = "app.getengram.daemon";
const SYSTEM = `system/${LABEL}`;
const LAUNCHCTL = "/bin/launchctl";
const KILL_BIN = "/bin/kill";
const CHOWN_BIN = MAC ? "/usr/sbin/chown" : "/bin/chown";
// Nothing listens on the discard port: the daemon never reaches a server.
const NOWHERE = "http://127.0.0.1:9";
/** The worker's script, as the CLI tells it (instance.ts). */
const WORKER_SCRIPT = /(?:^|[\s/\\])dist[\\/]daemon[\\/]worker(?:-main)?\.js(?:["\s]|$)/;

/** Every process: pid → its owner and command line. */
function processes() {
  const r = spawnSync("/bin/ps", ["-A", "-ww", "-o", "pid=,uid=,args="], {
    encoding: "utf-8",
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const found = new Map();
  for (const line of (r.stdout ?? "").split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) found.set(Number(match[1]), { uid: Number(match[2]), args: match[3].trimEnd() });
  }
  return found;
}

function launchctl(...args) {
  const r = spawnSync(LAUNCHCTL, args, { encoding: "utf-8", timeout: 30_000 });
  const stdout = r.stdout ?? "";
  return { status: r.status, stdout, out: `${stdout}${r.stderr ?? ""}${r.error ? r.error.message : ""}`.trim() };
}

const rootAlready = [...processes()].filter(([, p]) => p.uid === 0 && WORKER_SCRIPT.test(p.args)).map(([pid]) => pid);
if (rootAlready.length > 0) {
  console.error(`refusing: a worker runs as root already (pid ${rootAlready.join(", ")}), and would read as this test's`);
  process.exit(1);
}
if (MAC) {
  for (const service of [SYSTEM, `gui/${UID}/${LABEL}`]) {
    if (launchctl("print", service).status === 0) {
      console.error(`refusing: ${service} is loaded already`);
      process.exit(1);
    }
  }
}

process.umask(0o022);
// A short directory: the socket's path has to fit in about 100 bytes.
const scratch = realpathSync(mkdtempSync(join(Buffer.byteLength(tmpdir()) <= 60 ? tmpdir() : "/tmp", "e2e-680-")));
const home = join(scratch, "home");
const ENGRAM_DIR = join(home, ".engram");
const LOG_FILE = join(ENGRAM_DIR, "daemon.log");
const PID_FILE = join(ENGRAM_DIR, "daemon.pid");
const STATUS_FILE = join(ENGRAM_DIR, "status.json");
const SOCK = join(ENGRAM_DIR, "daemon.sock");
const PLIST = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
const UNIT = join(home, ".config", "systemd", "user", "engram.service");
if (Buffer.byteLength(SOCK) > 100) {
  console.error(`the socket's path would be too long here (${SOCK}): set TMPDIR to a shorter directory`);
  rmSync(scratch, { recursive: true, force: true });
  process.exit(2);
}
mkdirSync(ENGRAM_DIR, { recursive: true, mode: 0o700 });
writeFileSync(join(ENGRAM_DIR, "config.json"), `${JSON.stringify({ baseUrl: NOWHERE })}\n`, { mode: 0o600 });
writeFileSync(LOG_FILE, "", { mode: 0o600 });
mkdirSync(join(scratch, "tmp"));

// Stubs first on the CLI's PATH, which log every call. On macOS, launchctl
// goes on to the real one: the CLI has to find the job in the system
// domain. On Linux, there is no systemd user session to use.
const fakeBin = join(scratch, "bin");
const STUB_LOG = join(scratch, "calls.log");
mkdirSync(fakeBin);
const stubs = MAC
  ? [["osascript", "exit 0"], ["notify-send", "exit 0"], ["launchctl", `exec ${LAUNCHCTL} "$@"`]]
  : [["osascript", "exit 0"], ["notify-send", "exit 0"], ["launchctl", "exit 1"], ["systemctl", "exit 1"]];
for (const [name, then] of stubs) {
  writeFileSync(join(fakeBin, name), `#!/bin/sh\necho "${name} $*" >> "${STUB_LOG}"\n${then}\n`);
  chmodSync(join(fakeBin, name), 0o755);
}

const env = {
  PATH: `${fakeBin}:${dirname(NODE)}:/bin`,
  HOME: home,
  TMPDIR: join(scratch, "tmp"),
  ENGRAM_BASE_URL: NOWHERE,
  ENGRAM_NO_AUTOCAPTURE: "1",
  LANG: "en_US.UTF-8",
};

// A stand-in for the daemon a CLI from before engram#653 ran as root: it
// writes the PID file and status.json as that daemon did (status.json in
// place, so one root made stays root's), logs, and removes the PID file
// when it is stopped. Its script's path is a worker's, which is how the CLI
// tells a daemon. It runs nothing else.
const OLD = join(scratch, "old");
const STAND_IN = join(OLD, "dist", "daemon", "worker.js");
const LAUNCHER = join(OLD, "launch.cjs");
mkdirSync(dirname(STAND_IN), { recursive: true });
writeFileSync(join(OLD, "package.json"), `${JSON.stringify({ type: "commonjs" })}\n`);
writeFileSync(
  STAND_IN,
  [
    '"use strict";',
    'const fs = require("node:fs");',
    "process.umask(0o022);",
    `const PID_FILE = ${JSON.stringify(PID_FILE)};`,
    `fs.writeFileSync(PID_FILE, String(process.pid));`,
    "const status = {",
    '  health: "healthy", last_sync_at: null, last_error_at: null, last_error: null, error_type: null,',
    "  pending_messages: 0, consecutive_failures: 0, storage: null, updated_at: new Date().toISOString(),",
    "};",
    `fs.writeFileSync(${JSON.stringify(STATUS_FILE)}, JSON.stringify(status, null, 2));`,
    'console.log("[" + new Date().toISOString() + "] stand-in for a daemon from before engram#653 started (pid " +',
    '  process.pid + ", uid " + process.getuid() + ")");',
    "const stop = () => {",
    "  try { fs.unlinkSync(PID_FILE); } catch {}",
    "  process.exit(0);",
    "};",
    'process.on("SIGTERM", stop);',
    'process.on("SIGINT", stop);',
    "setInterval(() => {}, 1 << 30);",
    "",
  ].join("\n"),
);
// Starts it as `sudo engram start` started the daemon: detached, its output
// in the daemon's log. Prints its PID.
writeFileSync(
  LAUNCHER,
  [
    '"use strict";',
    'const { spawn } = require("node:child_process");',
    'const fs = require("node:fs");',
    `const fd = fs.openSync(${JSON.stringify(LOG_FILE)}, "a");`,
    `const child = spawn(process.execPath, [${JSON.stringify(STAND_IN)}], { detached: true, stdio: ["ignore", fd, fd] });`,
    "fs.closeSync(fd);",
    "process.stdout.write(String(child.pid));",
    "child.unref();",
    "",
  ].join("\n"),
);

// ── What the CLI says ──

const PROBLEM = (pid) => `A daemon started with sudo is still running as root (pid ${pid}).`;
const KILL = (pid) => `Stop it with: sudo kill ${pid}`;
const BOOTOUT = `Stop it with: sudo launchctl bootout ${SYSTEM}`;
const ALSO = "Also unload the job";
const STATUS_ROOT = (pid) => `Status: running as root (pid ${pid}), started with sudo`;
const WHY_STATUS = "'engram stop' can't stop it, and no daemon of yours starts while it runs.";
const WHY_START = "No daemon of yours starts while it runs.";
const WHY_STOP = "'engram stop' can't stop it.";
const WHY_INSTALL = "Start at login wasn't turned on: no daemon of yours starts while it runs.";
const AGAIN = (command) => `Then run '${command}' again.`;
const THEN_START = "Then run: engram start";
const WORKER_TAKEN = (pid) => `a daemon started with sudo is still running as root (pid ${pid}); this one is exiting`;
const WORKER_REFUSED = "daemon exiting: it runs as root, and Engram's daemon runs as you";
const UNTIED = (pid) =>
  `A daemon is running as root (pid ${pid}), most likely started with sudo. Stop it with: sudo kill ${pid}`;
const JOB_LEFT = "The job 'sudo engram install' loaded into launchd's system domain is still there";
const UNLOAD = `Unload it with: sudo launchctl bootout ${SYSTEM}`;
const FILES_BOTH = "status.json and daemon.pid in ~/.engram belong to root, not to you, so Engram can't update them.";
const FILE_STATUS = "status.json in ~/.engram belongs to root, not to you, so Engram can't update it.";
const CHOWN = `yours with: sudo chown -R "$(id -un)" ~/.engram`;
const STARTED = /(?:Engram daemon started|Engram daemon is starting) \(pid (\d+)\)/;
const AS_YOU = "Engram runs as you, and this is running as root.";
const DAEMON_AS_YOU = "Engram's daemon runs as you, and this is running as root.";
const PER_USER = "Start at login is per user, and this is running as root.";
const RUN_AS_YOU = (command) => `Run 'engram ${command}' as yourself, without sudo.`;

// ── Helpers ──

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) failures++;
  return ok;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
async function waitFor(what, test, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = test();
    if (v) {
      check(true, what);
      return v;
    }
    await sleep(250);
  }
  check(false, `${what} (gave up after ${ms / 1000}s)`);
  return null;
}

function engram(args, { quiet = false } = {}) {
  const r = spawnSync(NODE, [CLI, ...args], { env, cwd: scratch, encoding: "utf-8", timeout: 90_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  if (!quiet) {
    console.log(`\n$ engram ${args.join(" ")}  (exit ${r.status})`);
    for (const line of out.trimEnd().split("\n")) console.log(`  │ ${line}`);
  }
  return { status: r.status, out };
}

/** `sudo engram …`, with HOME the user's, as macOS sudo keeps it, and the rest of the user's environment. */
function sudoEngram(args) {
  const vars = Object.entries(env).map(([name, value]) => `${name}=${value}`);
  const r = spawnSync(SUDO, ["-n", "/usr/bin/env", ...vars, NODE, CLI, ...args], { cwd: scratch, encoding: "utf-8", timeout: 90_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? r.error.message : ""}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  console.log(`\n$ sudo engram ${args.join(" ")}  (exit ${r.status})`);
  for (const line of out.trimEnd().split("\n").slice(0, 8)) console.log(`  │ ${line}`);
  return { status: r.status, out };
}

/** The calls the stubs logged, one a line. */
function stubCalls() {
  try {
    return readFileSync(STUB_LOG, "utf-8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// The home has no API key, so `engram status` ends by saying so, and exits
// 1 for that, as it does with no daemon. That it says so shows it ran
// through to the end, past what it says of the daemon.
const NO_KEY = "Not authenticated. Run 'engram signup' first.";
function ranThrough(r) {
  return check(r.status === 1 && r.out.includes(NO_KEY), `status runs through, to the account it has no key for (exit ${r.status})`);
}

function says(r, what, ...lines) {
  const missing = lines.filter((line) => !r.out.includes(line));
  return check(missing.length === 0, missing.length === 0 ? what : `${what} (missing: ${missing.map((l) => JSON.stringify(l)).join(", ")})`);
}

function saysNot(r, what, ...lines) {
  const found = lines.filter((line) => r.out.includes(line));
  return check(found.length === 0, found.length === 0 ? what : `${what} (but it says: ${found.map((l) => JSON.stringify(l)).join(", ")})`);
}

function sudo(...args) {
  const r = spawnSync(SUDO, ["-n", ...args], { encoding: "utf-8", timeout: 60_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? r.error.message : ""}`.trim();
  console.log(`\n$ sudo ${args.join(" ")}  (exit ${r.status})`);
  for (const line of out ? out.split("\n") : []) console.log(`  │ ${line}`);
  return { status: r.status, out };
}

const standIns = new Set();
/** Starts the stand-in as root, as `sudo engram start` started the daemon. */
function startStandIn(what) {
  const r = spawnSync(SUDO, ["-n", "/usr/bin/env", `HOME=${home}`, NODE, LAUNCHER], { encoding: "utf-8", timeout: 30_000 });
  const pid = Number((r.stdout ?? "").trim());
  if (r.status !== 0 || !Number.isInteger(pid) || pid <= 0) {
    throw new Error(`couldn't start ${what} as root (exit ${r.status}): ${r.stdout ?? ""}${r.stderr ?? ""}`);
  }
  standIns.add(pid);
  console.log(`\nstarted ${what} as root: pid ${pid}`);
  return pid;
}

const isStandIn = (pid) => processes().get(pid)?.args === `${NODE} ${STAND_IN}`;
const isWorker = (args) => args.endsWith(` ${WORKER}`);
const BEFORE = new Set([...processes()].filter(([, p]) => isWorker(p.args)).map(([pid]) => pid));
/** Processes running this build's worker that this test started, as anyone. */
function ourWorkers() {
  return [...processes()]
    .filter(([pid, p]) => isWorker(p.args) && !BEFORE.has(pid))
    .map(([pid, p]) => ({ pid, uid: p.uid }));
}

function ownerOf(path) {
  try {
    return lstatSync(path).uid;
  } catch {
    return null;
  }
}
function pidFile() {
  try {
    const text = readFileSync(PID_FILE, "utf-8").trim();
    return /^\d+$/.test(text) ? Number(text) : null;
  } catch {
    return null;
  }
}
function logText() {
  try {
    return readFileSync(LOG_FILE, "utf-8");
  } catch {
    return "";
  }
}
const logCount = (text) => logText().split(text).length - 1;
const isSocket = () => {
  try {
    return lstatSync(SOCK).isSocket();
  } catch {
    return false;
  }
};
/** ~/.engram's files, each with its owner. */
function snapshot() {
  try {
    return readdirSync(ENGRAM_DIR)
      .sort()
      .map((name) => `${name}:${ownerOf(join(ENGRAM_DIR, name))}`)
      .join(" ");
  } catch {
    return "(none)";
  }
}

/** Runs the worker to its end, its output in the daemon's log, as the user or as root. */
function workerAs(what, { sudo: asRoot = false } = {}) {
  const fd = openSync(LOG_FILE, "a");
  try {
    const r = asRoot
      ? spawnSync(SUDO, ["-n", "/usr/bin/env", `HOME=${home}`, NODE, WORKER], {
          cwd: scratch,
          stdio: ["ignore", fd, fd],
          timeout: 30_000,
        })
      : spawnSync(NODE, [WORKER], { env, cwd: scratch, stdio: ["ignore", fd, fd], timeout: 30_000 });
    console.log(`\n${what}: exit ${r.status}${r.signal ? `, ended by ${r.signal}` : ""}`);
    return r;
  } finally {
    closeSync(fd);
  }
}

/** Engram's job in launchd's system domain, as launchctl prints it; null when it isn't loaded. */
function systemJob() {
  const r = launchctl("print", SYSTEM);
  if (r.status !== 0) return null;
  const lines = r.stdout.split("\n");
  const field = (name) => {
    const line = lines.find((l) => l.startsWith(`\t${name} = `));
    return line === undefined ? null : line.slice(name.length + 4);
  };
  return {
    state: field("state"),
    pid: Number(field("pid")) || 0,
    runs: Number(field("runs")) || 0,
    lastExit: field("last exit code"),
    path: field("path"),
  };
}

// What the CLI may tell the user to run, and this test runs: only these.
const TOLD = [
  /^sudo kill \d+( \d+)*$/,
  /^sudo launchctl bootout system\/app\.getengram\.daemon$/,
  /^sudo chown -R "\$\(id -un\)" ~\/\.engram$/,
];

/** Runs the command the CLI gave after `prefix`, as the user would, through sudo. */
function runAsTold(r, prefix, what) {
  const line = r.out.split("\n").find((l) => l.includes(prefix));
  const command = line === undefined ? null : line.slice(line.indexOf(prefix) + prefix.length).trim();
  if (!check(command !== null && TOLD.some((re) => re.test(command)), `${what} is one this test runs: ${JSON.stringify(command)}`)) {
    return false;
  }
  const shell = command.replace(/^sudo /, "sudo -n ");
  const run = spawnSync("/bin/sh", ["-c", shell], {
    env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    cwd: scratch,
    encoding: "utf-8",
    timeout: 60_000,
  });
  console.log(`\n$ ${shell}  (exit ${run.status})`);
  for (const l of `${run.stdout ?? ""}${run.stderr ?? ""}`.trimEnd().split("\n")) if (l) console.log(`  │ ${l}`);
  return check(run.status === 0, `'${command}' ran`);
}

/** The plist `engram install` wrote before engram#616, which 0.6.1 still wrote, for `program`. */
function plist06(program) {
  const jobPath = `${dirname(NODE)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>${program}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${home}</string>
    <key>PATH</key>
    <string>${jobPath}</string>
    <key>ENGRAM_PLIST_VERSION</key>
    <string>2</string>
  </dict>
</dict>
</plist>
`;
}

let loadedSystemJob = false;
/**
 * What `sudo engram install` did before engram#653: the plist, written as
 * root into the user's own ~/Library/LaunchAgents (so root's, and staff's,
 * the directory's group), loaded by root, which puts it in the system
 * domain. `bootstrap`, not `load -w`: that would leave launchd an override
 * to keep.
 */
function loadSystemJob(program, what) {
  rmSync(PLIST, { force: true });
  mkdirSync(dirname(PLIST), { recursive: true });
  writeFileSync(PLIST, plist06(program), { mode: 0o644 });
  if (sudo(CHOWN_BIN, "0", PLIST).status !== 0) return check(false, `${what}: the plist was made root's`);
  let r = sudo(LAUNCHCTL, "bootstrap", "system", PLIST);
  if (r.status !== 0 && launchctl("print", SYSTEM).status !== 0) {
    // In case launchd wants wheel's group too.
    sudo(CHOWN_BIN, "0:0", PLIST);
    r = sudo(LAUNCHCTL, "bootstrap", "system", PLIST);
  }
  loadedSystemJob = launchctl("print", SYSTEM).status === 0;
  return check(loadedSystemJob, `${what}: launchd loaded the plist into its system domain`);
}

// ── The checks ──

/** A daemon from before engram#653, started with `sudo engram start`: its PID file names it. */
async function tiedByPidFile() {
  console.log("\n── A daemon started with sudo engram start before engram#653: its PID file names it ──");
  const N = startStandIn("a stand-in for a daemon from before engram#653");
  const wrote = await waitFor(
    "it wrote its PID file and status.json, both root's",
    () => pidFile() === N && ownerOf(PID_FILE) === 0 && ownerOf(STATUS_FILE) === 0,
  );
  if (!wrote) return null;

  const status = engram(["status"]);
  ranThrough(status);
  says(
    status,
    "status says a daemon runs as root, how to stop it, and that its files are root's",
    STATUS_ROOT(N),
    `${PROBLEM(N)} ${WHY_STATUS}`,
    KILL(N),
    FILES_BOTH,
    `Then make them ${CHOWN}`,
    THEN_START,
  );

  for (const [command, why, again] of [
    ["start", WHY_START, "engram start"],
    ["stop", WHY_STOP, null],
    ["install", WHY_INSTALL, "engram install"],
  ]) {
    const r = engram([command]);
    check(r.status === 1, `${command} exits 1`);
    says(
      r,
      `${command} says a daemon runs as root, how to stop it, and that its files are root's`,
      `${PROBLEM(N)} ${why}`,
      KILL(N),
      FILES_BOTH,
      `Then make them ${CHOWN}`,
      ...(again === null ? [] : [AGAIN(again)]),
    );
    saysNot(r, `${command} starts no daemon`, "Engram daemon started", "Engram daemon is starting");
  }
  check(ourWorkers().length === 0, "no daemon of this build runs");
  check(isStandIn(N) && pidFile() === N, "the daemon running as root runs on, and its PID file is kept");
  check(!existsSync(PLIST) && !existsSync(UNIT), "install wrote no plist and no unit");

  const taken = logCount(WORKER_TAKEN(N));
  const asUser = workerAs("the worker, started as the user");
  check(asUser.status === 0 && asUser.signal === null, "the worker started as the user exits 0, which launchd leaves at that");
  check(logCount(WORKER_TAKEN(N)) === taken + 1, "its log says a daemon runs as root, and that it is exiting");
  check(!isSocket() && pidFile() === N, "it leaves no socket, and the PID file as it was");

  const banner = engram(["exclude", "list"]);
  check(banner.status === 0, "exclude list exits 0");
  says(banner, "another command's banner says it too", `engram: ${PROBLEM(N)}`, KILL(N), `engram: ${FILES_BOTH}`);

  const before = snapshot();
  const refused = logCount(WORKER_REFUSED);
  const asRoot = workerAs("the worker, started as root with sudo", { sudo: true });
  check(asRoot.status === 0 && asRoot.signal === null, "the worker started as root exits 0");
  check(logCount(WORKER_REFUSED) === refused + 1, "its log says it won't run as root");
  check(snapshot() === before && !isSocket(), `it made no file in ~/.engram (${snapshot()})`);
  return { status, N };
}

/** Stopped with the command status gave. */
async function stoppedAsTold(status, N) {
  console.log("\n── Stopped with the command status gave ──");
  runAsTold(status, "Stop it with: ", "status's command");
  await waitFor("the daemon running as root is gone, and its PID file with it", () => !isStandIn(N) && pidFile() === null);
  const after = engram(["status"]);
  says(after, "status says the daemon is stopped, and that status.json is root's", "Status: stopped", FILE_STATUS, `Make it ${CHOWN}`);
  saysNot(after, "status says no daemon runs as root", "running as root");
}

/** One whose PID file a CLI from before this change removed. */
async function pidFileRemoved() {
  console.log("\n── A daemon running as root whose PID file a CLI from before this change removed ──");
  const M = startStandIn("another stand-in");
  if (!(await waitFor("it wrote its PID file", () => pidFile() === M))) return null;
  // As 0.6.1 did: it couldn't signal the daemon (EPERM), took its PID file
  // for a dead daemon's, and removed it.
  unlinkSync(PID_FILE);
  const status = engram(["status"]);
  ranThrough(status);
  says(status, "status names it from the process list, with the command that stops it", "Status: stopped", UNTIED(M));
  const stop = engram(["stop"]);
  check(stop.status === 0, "stop exits 0");
  says(stop, "stop says no daemon of the user's runs, and names the one running as root", "Daemon is not running.", UNTIED(M));
  runAsTold(status, "Stop it with: ", "status's command");
  await waitFor("it is gone", () => !isStandIn(M));
  const after = engram(["status"]);
  says(after, "status still says status.json is root's", FILE_STATUS);
  saysNot(after, "status says no daemon runs as root", "running as root");
  return after;
}

/** The files made the user's again, as status said. */
async function filesMadeTheirs(status) {
  console.log("\n── The files made the user's again, as status said ──");
  runAsTold(status, "yours with: ", "status's command");
  const after = engram(["status"]);
  saysNot(after, "status says nothing of files that aren't the user's, or of root", "belong", "running as root");
  const banner = engram(["exclude", "list"]);
  saysNot(banner, "nor does another command's banner", "belong", "running as root");
  const start = engram(["start"]);
  const P = Number(STARTED.exec(start.out)?.[1]) || null;
  if (!check(start.status === 0 && P !== null, "start starts the user's own daemon")) return;
  await waitFor("it runs as the user", () => ourWorkers().some((w) => w.pid === P && w.uid === UID));
  says(engram(["status"]), "status says it runs", `Status: running (pid ${P})`);
  const stop = engram(["stop"]);
  check(stop.status === 0, "stop exits 0");
  says(stop, "stop stops it", `Daemon stopped (pid ${P})`);
  await waitFor("no daemon of this build runs", () => ourWorkers().length === 0);
}

/** macOS: the job `sudo engram install` loaded into the system domain, running the stand-in. */
async function systemJobRunsStandIn() {
  console.log("\n── macOS: a job sudo engram install loaded into launchd's system domain, running a daemon from before engram#653 ──");
  if (!loadSystemJob(STAND_IN, "the stand-in's job")) return;
  const job = await waitFor(
    "launchd runs the stand-in as root, and it wrote its PID file",
    () => {
      const j = systemJob();
      return j?.state === "running" && j.pid > 0 && isStandIn(j.pid) && pidFile() === j.pid ? j : null;
    },
    60_000,
  );
  if (job === null) return;
  const J = job.pid;
  standIns.add(J);
  check(job.path === PLIST, `the job is the user's own plist's (${job.path})`);
  // As 0.6.1 did: it couldn't signal the daemon, and removed its PID file.
  unlinkSync(PID_FILE);
  const plist = readFileSync(PLIST, "utf-8");

  const status = engram(["status"]);
  ranThrough(status);
  says(status, "status says the job runs a daemon as root, and to unload the job", STATUS_ROOT(J), `${PROBLEM(J)} ${WHY_STATUS}`, BOOTOUT);
  saysNot(status, "status says nothing of killing it, or of another job", "sudo kill", ALSO);

  for (const [command, why, again] of [
    ["start", WHY_START, "engram start"],
    ["stop", WHY_STOP, null],
    ["install", WHY_INSTALL, "engram install"],
  ]) {
    const r = engram([command]);
    check(r.status === 1, `${command} exits 1`);
    says(r, `${command} says the job runs a daemon as root, and to unload the job`, `${PROBLEM(J)} ${why}`, BOOTOUT, ...(again === null ? [] : [AGAIN(again)]));
    saysNot(r, `${command} starts no daemon`, "Engram daemon started", "Engram daemon is starting");
  }
  check(readFileSync(PLIST, "utf-8") === plist && ownerOf(PLIST) === 0, "the plist is as sudo engram install left it, root's");
  check(ourWorkers().length === 0, "no daemon of this build runs");
  check(isStandIn(J) && systemJob()?.pid === J, "the job still runs the stand-in");

  runAsTold(status, "Stop it with: ", "status's command");
  const gone = await waitFor("the job is unloaded, and the stand-in gone", () => launchctl("print", SYSTEM).status !== 0 && !isStandIn(J));
  if (gone) loadedSystemJob = false;
  const after = engram(["status"]);
  says(after, "status says the daemon is stopped", "Status: stopped");
  saysNot(after, "status says nothing of root, or of a job left", "running as root", JOB_LEFT);
}

/** macOS: that job running this build's worker. */
async function systemJobRunsWorker() {
  console.log("\n── macOS: that job running this build's worker ──");
  const before = snapshot();
  const refused = logCount(WORKER_REFUSED);
  if (!loadSystemJob(WORKER, "the worker's job")) return;
  const job = await waitFor(
    "launchd ran the worker as root, which wouldn't run, and exited 0",
    () => {
      const j = systemJob();
      return j !== null && j.runs >= 1 && j.state !== "running" && j.lastExit === "0" && logCount(WORKER_REFUSED) > refused ? j : null;
    },
    60_000,
  );
  if (job === null) return;
  // Gone, so that `engram start` doesn't rewrite it, as outdated, and load
  // it into the user's own session. launchd keeps the job it loaded.
  rmSync(PLIST);
  // KeepAlive starts it again only after a failure, ThrottleInterval later.
  await sleep(13_000);
  check(systemJob()?.runs === job.runs, `launchd didn't start it again (runs: ${job.runs}, then ${systemJob()?.runs})`);
  check(snapshot() === before && !isSocket(), `it made no file in ~/.engram (${snapshot()})`);

  const status = engram(["status"]);
  ranThrough(status);
  says(status, "status says the daemon is stopped, and the job is still loaded, and how to unload it", "Status: stopped", JOB_LEFT, UNLOAD);
  saysNot(status, "status says no daemon runs as root", "running as root");

  const start = engram(["start"]);
  const P = Number(STARTED.exec(start.out)?.[1]) || null;
  if (check(start.status === 0 && P !== null, "start starts the user's own daemon beside the job")) {
    await waitFor("it runs as the user", () => ourWorkers().some((w) => w.pid === P && w.uid === UID));
    says(engram(["status"]), "status says it runs, and the job is still loaded", `Status: running (pid ${P})`, JOB_LEFT);
    const stop = engram(["stop"]);
    says(stop, "stop stops it", `Daemon stopped (pid ${P})`);
    await waitFor("no daemon of this build runs", () => ourWorkers().length === 0);
  }

  runAsTold(status, "Unload it with: ", "status's command");
  if (await waitFor("the job is unloaded", () => launchctl("print", SYSTEM).status !== 0)) loadedSystemJob = false;
  saysNot(engram(["status"]), "status says nothing of the job any more", JOB_LEFT);
}

/**
 * Commands run with sudo (engram#682). Before, they ran, and wrote the
 * user's ~/.engram as root: config.json from login, exclude, stop and
 * uninstall, the vault key from `vault keygen --save`.
 */
function sudoCommands() {
  console.log("\n── Commands run with sudo (engram#682) ──");
  const before = snapshot();
  const config = readFileSync(join(ENGRAM_DIR, "config.json"), "utf-8");
  const calls = stubCalls().length;
  const vaultKey = join(ENGRAM_DIR, "vault-key");
  for (const [args, problem, fix] of [
    [["login", "--key", "eng_test_682_never_sent"], AS_YOU, RUN_AS_YOU("login")],
    [["exclude", "add", join(scratch, "private")], AS_YOU, RUN_AS_YOU("exclude add")],
    [["vault", "keygen", "--save"], AS_YOU, RUN_AS_YOU("vault keygen")],
    [["status"], AS_YOU, RUN_AS_YOU("status")],
    [["uninstall"], AS_YOU, RUN_AS_YOU("uninstall")],
    [["stop"], AS_YOU, `${RUN_AS_YOU("stop")} For a daemon started with sudo, it says what stops it.`],
    [["start"], DAEMON_AS_YOU, RUN_AS_YOU("start")],
    [["install"], PER_USER, RUN_AS_YOU("install")],
  ]) {
    const r = sudoEngram(args);
    check(r.status === 1, `sudo engram ${args[0]} exits 1`);
    says(r, `sudo engram ${args[0]} says to run it as yourself`, problem, fix);
    saysNot(r, `sudo engram ${args[0]} says nothing else`, "engram:", "eng_test_682");
  }
  const help = sudoEngram(["help"]);
  check(help.status === 0 && help.out.includes("USAGE"), "sudo engram help prints the help, and exits 0");
  saysNot(help, "and nothing else", "engram:", "as root");
  const version = sudoEngram(["version"]);
  check(version.status === 0 && /^engram \S+\n$/.test(version.out), `sudo engram version prints only the version (${JSON.stringify(version.out)})`);
  check(snapshot() === before, `none of them made or changed a file in ~/.engram (${snapshot()})`);
  check(readFileSync(join(ENGRAM_DIR, "config.json"), "utf-8") === config, "config.json is as it was");
  check(!existsSync(vaultKey), "no vault key was made");
  check(stubCalls().length === calls, "none of them ran launchctl or systemctl");
  check(!existsSync(PLIST) && !existsSync(UNIT), "no plist, and no unit");
}

/** The CLI only looked: launchctl print, list and print-disabled; systemctl show. */
function onlyLooked() {
  const lines = stubCalls();
  const launchd = lines.filter((l) => l.startsWith("launchctl ")).map((l) => l.split(" ")[1]);
  const changedLaunchd = [...new Set(launchd.filter((verb) => !["print", "list", "print-disabled"].includes(verb)))];
  check(
    changedLaunchd.length === 0,
    `the CLI only looked at launchd (${launchd.length} launchctl call(s)${changedLaunchd.length > 0 ? `, and these: ${changedLaunchd.join(", ")}` : ""})`,
  );
  const systemd = lines.filter((l) => l.startsWith("systemctl ")).map((l) => l.split(" ").slice(1).find((w) => !w.startsWith("-")));
  const changedSystemd = [...new Set(systemd.filter((verb) => verb !== "show"))];
  check(
    changedSystemd.length === 0,
    `the CLI only looked at systemd (${systemd.length} systemctl call(s)${changedSystemd.length > 0 ? `, and these: ${changedSystemd.join(", ")}` : ""})`,
  );
}

async function run() {
  sudoCommands();
  const tied = await tiedByPidFile();
  if (tied === null) return;
  await stoppedAsTold(tied.status, tied.N);
  const after = await pidFileRemoved();
  if (after !== null) await filesMadeTheirs(after);
  if (MAC) {
    await systemJobRunsStandIn();
    await systemJobRunsWorker();
  }
  onlyLooked();
}

function diagnostics() {
  console.log("\n── diagnostics ──");
  if (MAC) {
    const r = launchctl("print", SYSTEM);
    console.log(`$ launchctl print ${SYSTEM}  (exit ${r.status})\n${r.out}`);
  }
  console.log(`~/.engram: ${snapshot()}`);
  let calls = "(none)";
  try {
    calls = readFileSync(STUB_LOG, "utf-8").trimEnd();
  } catch {
    // none
  }
  console.log(`calls to the stubs:\n${calls}`);
  console.log(`daemon.log, its last 40 lines:\n${logText().trimEnd().split("\n").slice(-40).join("\n")}`);
}

let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  if (MAC && loadedSystemJob && launchctl("print", SYSTEM).status === 0) {
    spawnSync(SUDO, ["-n", LAUNCHCTL, "bootout", SYSTEM], { stdio: "ignore", timeout: 60_000 });
  }
  for (const pid of standIns) {
    if (isStandIn(pid)) spawnSync(SUDO, ["-n", KILL_BIN, "-9", String(pid)], { stdio: "ignore", timeout: 30_000 });
  }
  const deadline = Date.now() + 10_000;
  while ((ourWorkers().length > 0 || [...standIns].some(isStandIn)) && Date.now() < deadline) pause(250);
  const left = ourWorkers();
  for (const { pid, uid } of left) {
    if (uid === UID) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone since
      }
    } else {
      spawnSync(SUDO, ["-n", KILL_BIN, "-9", String(pid)], { stdio: "ignore", timeout: 30_000 });
    }
  }
  const leftStandIns = [...standIns].filter(isStandIn);
  check(
    left.length === 0 && leftStandIns.length === 0,
    `no process of this test left running${left.length + leftStandIns.length > 0 ? ` (left: ${[...left.map((w) => w.pid), ...leftStandIns].join(", ")})` : ""}`,
  );
  // Root's files in it, made the user's so they can be removed.
  if (basename(scratch).startsWith("e2e-680-")) {
    spawnSync(SUDO, ["-n", CHOWN_BIN, "-R", String(UID), scratch], { stdio: "ignore", timeout: 60_000 });
  }
  rmSync(scratch, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    cleanup();
    process.exit(130);
  });
}

try {
  await run();
} catch (err) {
  check(false, `the test itself failed: ${err instanceof Error ? err.stack : String(err)}`);
} finally {
  if (failures > 0) diagnostics();
  cleanup();
}
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
