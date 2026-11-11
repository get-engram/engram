#!/usr/bin/env node
/**
 * Start at login on macOS (engram#655), under the real launchd. The unit
 * tests check the plist's text and each launchctl call against a stub; this
 * loads the plist `engram install` writes into the user's own launchd, in
 * the domain of their login session (gui/<uid>), and checks:
 *
 *   - `engram install` writes ~/Library/LaunchAgents/app.getengram.daemon.plist,
 *     0644, which plutil reads back, and launchd loads it and starts the
 *     daemon: this Node and this build's worker, word for word, though the
 *     paths of Node and of the home hold `&`, `<`, `>` and quotes, which the
 *     plist escapes (engram#616), and the home a letter outside ASCII. The
 *     job has the plist's environment and log, and `engram status` finds it.
 *   - When launchd loads the job, as at login, ~/.engram is made 0700 again,
 *     and the log launchd opens for the daemon, 0600.
 *   - A daemon killed outright is started again; one `engram stop` stops
 *     exits 0, and isn't, even when the stop comes while it is still starting
 *     (engram#669: that one was ended by the signal, which launchd takes for
 *     a crash).
 *   - With the job loaded, `engram start` has launchd start the daemon
 *     (engram#641): the daemon it reports is the job's, launchd starts it
 *     again after it was killed, and a start right after a stop is the
 *     job's too. With a server set in its environment, which launchd's
 *     daemon wouldn't have, start starts the daemon itself, and a start
 *     after that says launchd doesn't run it, as `engram status` does
 *     under its Auto-start line (engram#692), which says nothing of it
 *     while launchd runs the daemon. `engram start --install` turns start
 *     at login on first, and launchd starts the daemon.
 *   - `engram install` after `engram stop`, the job loaded already, has
 *     launchd start the daemon too (engram#691): a job launchd has loaded
 *     isn't loaded again, which is what starts one at login. Installed
 *     again, it starts no other.
 *   - A daemon.log the user can't write costs only the log (engram#679).
 *     launchd never starts the daemon of a plist that names it: xpcproxy
 *     exits 78 (EX_CONFIG), and kickstart exits 0 all the same. `engram
 *     start` writes a plist without a log, which launchd runs, and says the
 *     daemon runs without its log, as `engram status` does; the log is left
 *     as it was. Once it can be written, that plist is outdated, status
 *     says the daemon doesn't write to the log and what has it write there
 *     (engram#720), and a stop and a start put the log back, and the daemon
 *     writes to it.
 *   - A plist and a worker marked as downloaded (com.apple.quarantine) load
 *     and run all the same.
 *   - The plist an older CLI wrote, naming worker-main.js, is outdated:
 *     `engram start` rewrites it and launchd loads the new one, and so does
 *     `engram install` while the older one's daemon runs. One daemon runs
 *     after either.
 *   - `engram status` says when the job was switched off with launchctl, and
 *     `engram install` switches it back on without starting a second daemon.
 *   - `engram uninstall` boots the job out, which stops the daemon launchd
 *     runs, and removes the plist; then it starts the daemon again outside
 *     launchd, from config.json's server, not ENGRAM_BASE_URL's, and it
 *     keeps running until `engram stop` or sign-out, as on Linux and Windows
 *     (engram#667).
 *   - A plist from before engram#616, its paths unescaped, launchd can't
 *     load: `engram status` says it's broken, and `engram start` rewrites it
 *     and launchd loads it.
 *
 * Usage, on a macOS CI runner, after `pnpm build`:
 *
 *   ENGRAM_E2E_LAUNCHD=1 node scripts/e2e-launchd.mjs
 *
 * It loads a job into the user's real launchd, under the label a real
 * install uses, so it runs only when asked to and only where CI=true, and
 * refuses if that label is loaded, switched off, or has a plist in the
 * user's own ~/Library/LaunchAgents already. The daemon runs signed out,
 * under a temporary home, with no key and a server address that nothing
 * answers on. It signals only the workers it started: the copy of Node it
 * makes, running this build's worker.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  statSync, writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

if (process.env.ENGRAM_E2E_LAUNCHD !== "1") {
  console.log("skipped: set ENGRAM_E2E_LAUNCHD=1 to run it (CI only: it loads a job into the user's launchd)");
  process.exit(0);
}
if (process.platform !== "darwin" || process.env.CI !== "true") {
  console.error(
    "refusing: this loads a job into the user's launchd under the label a real install uses, " +
      "so it runs only on a macOS CI runner (CI=true)",
  );
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
// The entry point plists from CLIs before v2 name (engram#469).
const WORKER_MAIN = join(dirname(WORKER), "worker-main.js");
if (!existsSync(WORKER_MAIN)) {
  console.error(`no ${WORKER_MAIN} in the build`);
  process.exit(2);
}

/** A server address nothing answers on: the daemon has no key anyway. */
const NOWHERE = "http://127.0.0.1:9";
const LABEL = "app.getengram.daemon";
const DOMAIN = `gui/${process.getuid()}`;
const SERVICE = `${DOMAIN}/${LABEL}`;
const PLUTIL = "/usr/bin/plutil";
const XATTR = "/usr/bin/xattr";
const QUARANTINE = "com.apple.quarantine";

/** launchctl, by its full path, as this test's user. */
function launchctl(...args) {
  const r = spawnSync("/bin/launchctl", args, { encoding: "utf-8", timeout: 30_000 });
  const stdout = r.stdout ?? "";
  return { status: r.status, stdout, out: `${stdout}${r.stderr ?? ""}${r.error ? r.error.message : ""}`.trim() };
}

// The domain `engram install` loads the job into: the user's login session.
const session = launchctl("print", DOMAIN);
if (session.status !== 0) {
  console.error(`no launchd domain for this user's login session (${DOMAIN}): ${session.out.split("\n")[0]}`);
  process.exit(1);
}
console.log(`launchd domain: ${DOMAIN}; this process's session: ${launchctl("managername").out}`);

const there = (p) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * launchd's switch for the label in this domain, as print-disabled gives it:
 * "disabled" or "enabled" ("true" or "false" on older macOS), or null when
 * it has none.
 */
function switchOf() {
  const line = launchctl("print-disabled", DOMAIN)
    .stdout.split("\n")
    .find((l) => l.trim().startsWith(`"${LABEL}" =>`));
  return line === undefined ? null : line.split("=>")[1].trim();
}
const isOff = (v) => v === "disabled" || v === "true";
const isOn = (v) => v === "enabled" || v === "false";

const REAL_PLIST = join(userInfo().homedir, "Library", "LaunchAgents", `${LABEL}.plist`);
if (launchctl("print", SERVICE).status === 0) {
  console.error(`${SERVICE} is loaded already: refusing to touch it`);
  process.exit(1);
}
if (there(REAL_PLIST)) {
  console.error(`${REAL_PLIST} is there already: refusing to touch it`);
  process.exit(1);
}
if (isOff(switchOf())) {
  console.error(`${LABEL} is switched off in launchd already: refusing to touch it`);
  process.exit(1);
}

// ── The temporary home, and Node at an odd path ─────────────────────────────
// What a plist must escape, & < >, and quotes, which it needn't; the home a
// letter outside ASCII too. Node's folder keeps to ASCII, as ps shows it,
// since the checks below find the workers by their command lines.
process.umask(0o022);
const root = realpathSync(mkdtempSync(join(tmpdir(), "e2e-ld-")));
const ODD = `O'Brien & "Q" <x>`;
const home = join(root, `${ODD} ü`);
const NODE_DIR = join(root, `node ${ODD}`);
const NODE = join(NODE_DIR, "node");
mkdirSync(home);
mkdirSync(NODE_DIR);
copyFileSync(process.execPath, NODE);
chmodSync(NODE, 0o755);
const ENGRAM_DIR = join(home, ".engram");
const LOG_FILE = join(ENGRAM_DIR, "daemon.log");
const PLIST = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
if (Buffer.byteLength(join(ENGRAM_DIR, "daemon.sock")) > 100) {
  console.error(`the daemon's socket path would be too long under ${root}: set TMPDIR to a shorter folder`);
  rmSync(root, { recursive: true, force: true });
  process.exit(2);
}
// launchd gives the daemon the plist's environment and nothing else, so the
// server address goes in config.json. ~/.engram as others can read it, which
// the daemon puts right.
mkdirSync(ENGRAM_DIR, { mode: 0o755 });
writeFileSync(join(ENGRAM_DIR, "config.json"), `${JSON.stringify({ baseUrl: NOWHERE })}\n`, { mode: 0o600 });
/** The PATH the CLI gives the job: Node's own folder first. */
const PLIST_PATH_ENV = `${NODE_DIR}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
const env = {
  PATH: `${NODE_DIR}:/usr/local/bin:/usr/bin:/bin`,
  HOME: home,
  ENGRAM_NO_AUTOCAPTURE: "1",
  ENGRAM_BASE_URL: NOWHERE,
  LANG: "en_US.UTF-8",
};
/**
 * The same without ENGRAM_BASE_URL. With it set, `engram start` starts the
 * daemon itself, since launchd's daemon wouldn't have it (engram#641);
 * without it, both read the server address from config.json.
 */
const launchdEnv = { ...env };
delete launchdEnv.ENGRAM_BASE_URL;

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) failures++;
  return ok;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** For cleanup, which runs from a signal handler too. */
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

function engram(args, { quiet = false, env: environment = env } = {}) {
  const r = spawnSync(NODE, [CLI, ...args], { env: environment, cwd: root, encoding: "utf-8", timeout: 90_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "");
  if (!quiet) {
    console.log(`\n$ engram ${args.join(" ")}  (exit ${r.status})`);
    for (const line of out.trimEnd().split("\n")) console.log(`  │ ${line}`);
  }
  return { status: r.status, out };
}

/** Every process, by pid: its command line, as ps gives it. */
function processes() {
  const r = spawnSync("/bin/ps", ["-axww", "-o", "pid=,command="], { encoding: "utf-8", timeout: 30_000 });
  const found = new Map();
  for (const line of (r.stdout ?? "").split("\n")) {
    const m = /^\s*(\d+) (.*)$/.exec(line);
    if (m) found.set(Number(m[1]), m[2].trimEnd());
  }
  return found;
}
/** This test's workers: its copy of Node running this build's worker, or what older plists name. */
const OURS = [`${NODE} ${WORKER}`, `${NODE} ${WORKER_MAIN}`];
const commandOf = (pid) => processes().get(pid) ?? null;
const isOurWorker = (pid) => pid > 0 && OURS.includes(commandOf(pid));
const ourWorkers = () => [...processes()].filter(([, command]) => OURS.includes(command)).map(([pid]) => pid);

/**
 * The job as launchd has it (launchctl print), or null when it isn't loaded.
 * Fields are `\t<name> = <value>`; arguments and environment are blocks of
 * `\t\t` lines, the environment's `KEY => VALUE`.
 */
function job() {
  const r = launchctl("print", SERVICE);
  if (r.status !== 0) return null;
  const lines = r.stdout.split("\n");
  const field = (name) => {
    const line = lines.find((l) => l.startsWith(`\t${name} = `));
    return line === undefined ? null : line.slice(name.length + 4);
  };
  const block = (name) => {
    const start = lines.indexOf(`\t${name} = {`);
    if (start < 0) return null;
    const end = lines.indexOf("\t}", start);
    return lines.slice(start + 1, end < 0 ? undefined : end).map((l) => l.replace(/^\t\t/, ""));
  };
  const environment = {};
  for (const l of block("environment") ?? []) {
    const at = l.indexOf(" => ");
    if (at > 0) environment[l.slice(0, at)] = l.slice(at + 4);
  }
  return {
    state: field("state"),
    pid: Number(field("pid")) || 0,
    runs: Number(field("runs")) || 0,
    lastExit: field("last exit code"),
    // Instead of an exit code, when a signal ended it: `<name>: <number>`.
    lastSignal: field("last terminating signal"),
    path: field("path"),
    stdout: field("stdout path"),
    stderr: field("stderr path"),
    args: block("arguments"),
    environment,
  };
}

/** launchd running one of this test's workers, other than `not`: its pid. */
const waitForJob = (what, not = 0, ms = 60_000) =>
  waitFor(what, () => {
    const j = job();
    return j !== null && j.state === "running" && j.pid !== not && isOurWorker(j.pid) ? j.pid : 0;
  }, ms);
/** After a bootout: launchd has let go of the job, and its daemon has gone. */
const waitForGone = (what) => waitFor(what, () => job() === null && ourWorkers().length === 0);

const modeOf = (p) => {
  try {
    return (statSync(p).mode & 0o777).toString(8);
  } catch {
    return "missing";
  }
};
const logText = () => (existsSync(LOG_FILE) ? readFileSync(LOG_FILE, "utf-8") : "");
const startedPid = (out) => Number(/Engram daemon started \(pid (\d+)\)/.exec(out)?.[1]) || null;
const autoStartLine = (out) => out.split("\n").map((l) => l.trim()).find((l) => l.startsWith("Auto-start:")) ?? null;
const KEEPS_RUNNING = "The daemon keeps running until 'engram stop' or sign-out.";

/**
 * Whether the process has `name` set in its environment, as `ps -E` shows
 * it after the command; null when ps shows no environment for it (it does
 * for Node run by the same user). Never prints the environment. HOME, which
 * every daemon of this test has, tells the two apart; not by its value,
 * whose "ü" ps may print otherwise.
 */
function hasEnv(pid, name) {
  const r = spawnSync("/bin/ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf-8", timeout: 30_000 });
  const line = (r.stdout ?? "").trim();
  if (!line.includes(" HOME=")) return null;
  return line.includes(` ${name}=`);
}

/** `engram status` finds the daemon with this pid: its output. */
async function statusRunning(pid, what) {
  const ok = await waitFor(`${what}: status finds the daemon (pid ${pid})`, () =>
    engram(["status"], { quiet: true }).out.includes(`Status: running (pid ${pid})`),
  );
  return { ok: Boolean(ok), ...engram(["status"]) };
}

/** The plist as plutil reads it, as JSON: null when it can't. */
function plistAsJson() {
  const r = spawnSync(PLUTIL, ["-convert", "json", "-o", "-", PLIST], { encoding: "utf-8", timeout: 30_000 });
  try {
    return r.status === 0 ? JSON.parse(r.stdout) : null;
  } catch {
    return null;
  }
}
const plistText = () => (existsSync(PLIST) ? readFileSync(PLIST, "utf-8") : null);
function writePlist(text) {
  writeFileSync(PLIST, text);
  chmodSync(PLIST, 0o644);
}
const bootout = () => launchctl("bootout", SERVICE);
const bootstrap = () => launchctl("bootstrap", DOMAIN, PLIST);

/** As a plist has text: & < > escaped. */
const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** The plist CLIs before v2 wrote: worker-main.js, and no PATH or version in the environment. */
function asV1(text) {
  const v1 = text
    .replace(`<string>${xml(WORKER)}</string>`, () => `<string>${xml(WORKER_MAIN)}</string>`)
    .replace(
      /\n    <key>PATH<\/key>\n    <string>[^<]*<\/string>\n    <key>ENGRAM_PLIST_VERSION<\/key>\n    <string>\d+<\/string>/,
      () => "",
    );
  if (!v1.includes(xml(WORKER_MAIN)) || v1.includes("ENGRAM_PLIST_VERSION")) throw new Error("not a plist of ours");
  return v1;
}
/** The plist CLIs before engram#616 wrote: the same, its paths unescaped. */
const unescaped = (text) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Files this test marked as downloaded, for cleanup to unmark. */
const marked = [];
function unmark() {
  while (marked.length > 0) spawnSync(XATTR, ["-d", QUARANTINE, marked.pop()]);
}
/** Whether this test switched the job off in launchd, and hasn't switched it back on. */
let switchedOff = false;

let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  bootout();
  if (switchedOff) launchctl("enable", SERVICE);
  unmark();
  // A daemon launchd ran gets a moment to finish as it stops.
  const deadline = Date.now() + 10_000;
  while (ourWorkers().length > 0 && Date.now() < deadline) pause(250);
  const left = ourWorkers();
  for (const pid of left) process.kill(pid, "SIGKILL");
  check(left.length === 0, `no worker of this test left running${left.length ? ` (killed ${left.join(", ")})` : ""}`);
  rmSync(root, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    cleanup();
    process.exit(130);
  });
}

function diagnostics() {
  console.log("\n── diagnostics ──");
  const runs = [
    ["/bin/launchctl", ["print", SERVICE]],
    [
      "/usr/bin/log",
      ["show", "--last", "15m", "--style", "compact", "--predicate", `eventMessage CONTAINS "${LABEL}"`],
    ],
  ];
  for (const [cmd, args] of runs) {
    const r = spawnSync(cmd, args, { encoding: "utf-8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trimEnd().split("\n").slice(-80).join("\n");
    console.log(`\n$ ${cmd} ${args.join(" ")}\n${out}`);
  }
  const switches = launchctl("print-disabled", DOMAIN).stdout.split("\n").filter((l) => l.includes(LABEL));
  console.log(`\n$ launchctl print-disabled ${DOMAIN}, the label's line\n${switches.join("\n") || "(none)"}`);
  console.log(`\n── the plist ──\n${plistText() ?? "(none)"}`);
  console.log(`\n── daemon.log, last 40 lines ──\n${logText().split("\n").slice(-40).join("\n")}`);
}

/** What start and status say while the log can't be written (engram#679). */
const WITHOUT_LOG = `Log: ${LOG_FILE} can't be written (EACCES), so the daemon runs without it.`;

/**
 * A daemon.log the user can't write costs only the log (engram#679). Run
 * with the job loaded from `installed`, the plist install writes, and no
 * daemon running; it leaves them so.
 */
async function withoutItsLog(installed) {
  const before = logText();
  chmodSync(LOG_FILE, 0o400);

  // What the plist without a log is for: launchd never starts the daemon of
  // a plist naming one it can't open, and tries again every 10 s.
  const runsBefore = job()?.runs ?? 0;
  const kick = launchctl("kickstart", SERVICE);
  await sleep(3_000);
  const refused = job();
  check(
    kick.status === 0 &&
      refused !== null &&
      refused.state !== "running" &&
      refused.runs > runsBefore &&
      refused.lastExit?.startsWith("78") === true &&
      ourWorkers().length === 0,
    `the log read-only, launchd never starts the daemon of a plist naming it (kickstart exit ${kick.status}; ` +
      `state ${refused?.state}, runs ${runsBefore} → ${refused?.runs}, last exit code ${refused?.lastExit})`,
  );

  const start = engram(["start"], { env: launchdEnv });
  check(start.status === 0, "start, the log read-only: exits 0");
  check(start.out.includes("Updated auto-start configuration (plist v2)"), "start: rewrites the plist launchd can't run");
  const read = plistAsJson();
  check(
    read !== null &&
      !("StandardOutPath" in read) &&
      !("StandardErrorPath" in read) &&
      isDeepStrictEqual(read.ProgramArguments, [NODE, WORKER]),
    "plutil: the plist names no log, and this Node and worker",
  );
  const pid = startedPid(start.out);
  const running = job();
  check(
    pid !== null && running?.state === "running" && running.pid === pid && isOurWorker(pid),
    `start: launchd runs the daemon without the log (pid ${pid}; launchd's ${running?.pid}, ${running?.state})`,
  );
  check(
    running !== null && running.stdout !== LOG_FILE && running.stderr !== LOG_FILE,
    `launchctl print: no log (${running?.stdout}, ${running?.stderr})`,
  );
  check(
    start.out.includes(`${WITHOUT_LOG}\n  To fix it, run: chmod u+w ~/.engram/daemon.log`),
    "start: says the daemon runs without its log, and what fixes it",
  );
  if (pid !== null && isOurWorker(pid)) {
    const status = await statusRunning(pid, "the log read-only");
    check(
      autoStartLine(status.out) === "Auto-start: enabled (launchd)",
      `status: start at login is on, nothing broken or outdated (${autoStartLine(status.out)})`,
    );
    check(status.out.includes(WITHOUT_LOG), "status: says the daemon runs without its log");
  }
  check(modeOf(LOG_FILE) === "400" && logText() === before, `daemon.log is as it was (${modeOf(LOG_FILE)}), nothing added`);

  // Put right: the plist without the log is outdated, and a stop and a
  // start put the log back.
  chmodSync(LOG_FILE, 0o600);
  const fixed = engram(["status"], { env: launchdEnv });
  check(
    autoStartLine(fixed.out)?.includes("outdated config, run 'engram install' to update") === true,
    `status, the log writable again: the plist without it is outdated (${autoStartLine(fixed.out)})`,
  );
  check(
    fixed.out.includes(
      `Log: ${LOG_FILE}, but the daemon doesn't write to it: it started without it.\n` +
        "  'engram stop' and then 'engram start' have the daemon write to it.",
    ) && !/can't be written|journal/.test(fixed.out),
    "status, the log writable again: says the daemon doesn't write to it, and what has it write there (engram#720)",
  );
  const stop = engram(["stop"]);
  check(stop.out.includes(`Daemon stopped (pid ${pid})`), `stop: stops the daemon (pid ${pid})`);
  await waitFor("stop: no daemon runs", () => ourWorkers().length === 0);
  const again = engram(["start"], { env: launchdEnv });
  check(again.status === 0, "start, the log writable again: exits 0");
  check(again.out.includes("Updated auto-start configuration (plist v2)"), "start: says it rewrote the plist");
  check(plistText() === installed, "start: the plist is the one install writes, the log back in it");
  const againPid = startedPid(again.out);
  const againJob = job();
  check(
    againPid !== null && againJob?.state === "running" && againJob.pid === againPid && againJob.stdout === LOG_FILE,
    `start: launchd runs the daemon with its log (pid ${againPid}; launchd's ${againJob?.pid}, log ${againJob?.stdout})`,
  );
  check(
    again.out.includes(`Log: ${LOG_FILE}\n`) && !again.out.includes("can't be written"),
    "start: names the log, and nothing more of it",
  );
  if (againPid !== null) {
    await waitFor(`daemon.log: the daemon started (pid ${againPid})`, () => logText().includes(`daemon started (pid ${againPid})`));
  }
  engram(["stop"]);
  await waitFor("stop: no daemon runs", () => ourWorkers().length === 0);
}

async function run() {
  // ── engram install ─────────────────────────────────────────────────────────
  const install = engram(["install"]);
  check(install.status === 0, "install: exits 0");
  check(install.out.includes("Auto-start enabled — daemon will start on login"), "install: says start at login is on");
  check(install.out.includes(`Plist: ${PLIST}`), `install: names the plist, ${PLIST}`);
  check(!install.out.includes("Engram daemon started"), "install: leaves starting the daemon to launchd");
  check(modeOf(PLIST) === "644", `the plist is 0644 (${modeOf(PLIST)})`);
  const lint = spawnSync(PLUTIL, ["-lint", PLIST], { encoding: "utf-8", timeout: 30_000 });
  check(lint.status === 0, `plutil -lint: ${`${lint.stdout ?? ""}${lint.stderr ?? ""}`.trim()}`);
  const read = plistAsJson();
  check(isDeepStrictEqual(read?.ProgramArguments, [NODE, WORKER]), "plutil reads the arguments back: this Node and worker");
  check(
    isDeepStrictEqual(read?.EnvironmentVariables, { HOME: home, PATH: PLIST_PATH_ENV, ENGRAM_PLIST_VERSION: "2" }),
    "plutil reads the environment back: the home, Node's folder first on PATH, the plist's version",
  );
  check(read?.StandardOutPath === LOG_FILE && read?.StandardErrorPath === LOG_FILE, "plutil reads the log back: daemon.log");
  const INSTALLED = plistText();

  const first = await waitForJob("launchd starts the daemon when install loads the job");
  if (!first) return;
  const loaded = job();
  check(loaded.path === PLIST, `launchctl print: the job is the plist (${loaded.path})`);
  check(isDeepStrictEqual(loaded.args, [NODE, WORKER]), `launchctl print: its arguments (${JSON.stringify(loaded.args)})`);
  check(loaded.environment.HOME === home, `launchctl print: HOME (${loaded.environment.HOME})`);
  check(loaded.environment.PATH === PLIST_PATH_ENV, `launchctl print: PATH (${loaded.environment.PATH})`);
  check(loaded.environment.ENGRAM_PLIST_VERSION === "2", "launchctl print: the plist's version");
  check(loaded.stdout === LOG_FILE && loaded.stderr === LOG_FILE, `launchctl print: the log (${loaded.stdout}, ${loaded.stderr})`);
  check(commandOf(first) === `${NODE} ${WORKER}`, `ps: this Node, running this worker (${commandOf(first)})`);
  await waitFor(`daemon.log: the daemon started (pid ${first})`, () => logText().includes(`daemon started (pid ${first})`));
  await waitFor("~/.engram is 0700, daemon.log 0600", () => modeOf(ENGRAM_DIR) === "700" && modeOf(LOG_FILE) === "600");
  const installed = await statusRunning(first, "install");
  check(
    autoStartLine(installed.out) === "Auto-start: enabled (launchd)",
    `status: start at login is on, nothing broken or outdated (${autoStartLine(installed.out)})`,
  );

  // ── As at login: launchd loads the job, ~/.engram open to others ──────────
  bootout();
  await waitForGone("bootout: launchd lets go of the job, and its daemon stops");
  rmSync(LOG_FILE, { force: true });
  chmodSync(ENGRAM_DIR, 0o755);
  const atLoad = bootstrap();
  check(atLoad.status === 0, `launchctl bootstrap loads the plist${atLoad.out ? ` (${atLoad.out})` : ""}`);
  const atLogin = await waitForJob("launchd starts the daemon as it loads the job, as at login");
  if (!atLogin) return;
  await waitFor(`daemon.log: the daemon started (pid ${atLogin})`, () => logText().includes(`daemon started (pid ${atLogin})`));
  const fixed = await waitFor(
    "~/.engram is 0700 again, and the log launchd opened for it, 0600",
    () => modeOf(ENGRAM_DIR) === "700" && modeOf(LOG_FILE) === "600",
  );
  if (!fixed) console.log(`      ~/.engram ${modeOf(ENGRAM_DIR)}, daemon.log ${modeOf(LOG_FILE)}`);
  await statusRunning(atLogin, "as at login");

  // ── Killed outright: launchd starts it again ────────────────────────────────
  const runsBefore = job()?.runs ?? 0;
  if (isOurWorker(atLogin)) process.kill(atLogin, "SIGKILL");
  const again = await waitForJob("launchd starts the daemon again after it was killed", atLogin);
  if (!again) return;
  const restarted = job();
  check(restarted?.runs === runsBefore + 1, `launchctl print: runs went from ${runsBefore} to ${restarted?.runs}`);
  await statusRunning(again, "after the kill");

  // ── engram stop: launchd leaves it stopped ──────────────────────────────────
  const stop = engram(["stop"]);
  check(stop.out.includes(`Daemon stopped (pid ${again})`), `stop: stops the daemon launchd runs (pid ${again})`);
  await waitFor("launchd has the job stopped", () => {
    const j = job();
    return j !== null && j.state !== "running";
  });
  const runsStopped = job()?.runs ?? 0;
  await sleep(13_000); // ThrottleInterval is 10s: a restart would be in by now.
  const stopped = job();
  check(
    stopped !== null && stopped.state !== "running" && stopped.runs === runsStopped && ourWorkers().length === 0,
    `launchd didn't start it again (state ${stopped?.state}, runs ${stopped?.runs}, workers ${ourWorkers().length})`,
  );
  check(
    stopped?.lastExit === "0",
    `it exited 0, so KeepAlive leaves it stopped (last exit code ${stopped?.lastExit}, ` +
      `last terminating signal ${stopped?.lastSignal ?? "none"})`,
  );

  // ── engram start: launchd starts the daemon (engram#641) ───────────────────
  // The job is loaded, and its daemon stopped.
  const runsBeforeStart = job()?.runs ?? 0;
  const kickAt = Date.now();
  const kick = engram(["start"], { env: launchdEnv });
  console.log(`      start took ${Date.now() - kickAt} ms`);
  check(kick.status === 0, "start: exits 0");
  check(!kick.out.includes("started directly"), "start: has launchd start the daemon");
  const kicked = startedPid(kick.out);
  const kickedJob = job();
  check(
    kicked !== null && kickedJob?.state === "running" && kickedJob.pid === kicked,
    `start: the daemon it started is launchd's (pid ${kicked}; launchd's ${kickedJob?.pid}, ${kickedJob?.state})`,
  );
  check(kickedJob?.runs === runsBeforeStart + 1, `launchctl print: runs went from ${runsBeforeStart} to ${kickedJob?.runs}`);
  if (!kicked || !isOurWorker(kicked)) return;
  check(commandOf(kicked) === `${NODE} ${WORKER}`, `ps: this Node, running this worker (${commandOf(kicked)})`);

  const twice = engram(["start"], { env: launchdEnv });
  check(twice.out.includes(`Daemon already running (pid ${kicked})`), `start again: the daemon runs (pid ${kicked})`);
  check(!twice.out.includes("wasn't started by launchd"), "start again: says nothing of launchd, which runs it");
  check(
    job()?.pid === kicked && isDeepStrictEqual(ourWorkers(), [kicked]),
    `start again: the same daemon, and only it (${ourWorkers().join(", ")})`,
  );
  // Nor does engram status (engram#692).
  const kickedStatus = engram(["status"], { env: launchdEnv });
  check(
    autoStartLine(kickedStatus.out) === "Auto-start: enabled (launchd)",
    `status: start at login is on (${autoStartLine(kickedStatus.out)})`,
  );
  check(!kickedStatus.out.includes("wasn't started by launchd"), "status: says nothing of launchd, which runs the daemon");

  // Killed outright: launchd starts it again, as it does the one it starts at login.
  process.kill(kicked, "SIGKILL");
  const respawned = await waitForJob("launchd starts the daemon start had it start again after it was killed", kicked);
  if (!respawned) return;
  const respawnedAt = Date.now();
  await statusRunning(respawned, "after the kill");

  // At once after a stop, as `engram stop && engram start` does: within the
  // job's ThrottleInterval (10s) of launchd starting the last one. kickstart
  // runs a job "immediately, regardless of its configured launch conditions"
  // (launchctl(1)); were it put off, start would wait 3s for it, and then
  // start the daemon itself, and say so.
  const stopRespawned = engram(["stop"]);
  check(stopRespawned.out.includes(`Daemon stopped (pid ${respawned})`), `stop: stops the daemon (pid ${respawned})`);
  const sinceLast = Date.now() - respawnedAt;
  const restartAt = Date.now();
  const restart = engram(["start"], { env: launchdEnv });
  const restartMs = Date.now() - restartAt;
  const restartJob = job();
  console.log(
    `      start at once after a stop, ${sinceLast} ms after launchd started the last daemon: ` +
      `took ${restartMs} ms; the job is ${restartJob?.state} (pid ${restartJob?.pid})`,
  );
  check(restart.status === 0, "start at once after a stop: exits 0");
  check(!restart.out.includes("started directly"), "start at once after a stop: launchd starts the daemon in time");
  const restartedPid = startedPid(restart.out);
  const throughLaunchd = restartedPid !== null && restartJob?.state === "running" && restartJob.pid === restartedPid;
  check(
    throughLaunchd,
    `start at once after a stop: the daemon is launchd's (pid ${restartedPid}; launchd's ${restartJob?.pid})`,
  );
  // A start launchd put off comes in by the end of the ThrottleInterval: let
  // it, so what follows begins with no daemon.
  if (!throughLaunchd) await sleep(Math.max(0, 12_000 - (Date.now() - respawnedAt)));

  // With a server set here, start starts the daemon itself; a start after
  // that says launchd doesn't run it, and how to hand it over.
  engram(["stop"]);
  await waitFor("stop: no daemon runs", () => ourWorkers().length === 0);
  const direct = engram(["start"]);
  const directPid = startedPid(direct.out);
  check(direct.status === 0 && directPid !== null, `start with ENGRAM_BASE_URL set: starts the daemon (pid ${directPid})`);
  const directJob = job();
  check(
    directJob !== null && directJob.state !== "running",
    `start with ENGRAM_BASE_URL set: launchd doesn't run it (the job is ${directJob?.state})`,
  );
  const outside = engram(["start"], { env: launchdEnv });
  check(outside.out.includes(`Daemon already running (pid ${directPid})`), `start: the daemon runs (pid ${directPid})`);
  check(
    outside.out.includes(`The running daemon (pid ${directPid}) wasn't started by launchd`),
    "start: says launchd won't restart it after a crash",
  );
  const outsideStatus = engram(["status"], { env: launchdEnv });
  check(
    outsideStatus.out.includes(
      `Auto-start: enabled (launchd)\n  The running daemon (pid ${directPid}) wasn't started by launchd`,
    ),
    "status: says it too, under its Auto-start line (engram#692)",
  );
  check(job()?.state !== "running", "start: leaves it running, and launchd's job stopped");
  engram(["stop"]);
  await waitFor("stop: no daemon runs", () => ourWorkers().length === 0);

  // ── engram install after engram stop: launchd starts it (engram#691) ───────
  // The job is loaded, and no daemon runs: the one `engram stop` stopped
  // exited 0, which KeepAlive doesn't start again, and install doesn't load
  // a job that is loaded already, which is what starts one.
  const runsBeforeInstall = job()?.runs ?? 0;
  const reinstall = engram(["install"], { env: launchdEnv });
  check(reinstall.status === 0, "install after a stop: exits 0");
  check(
    reinstall.out.includes("Auto-start enabled — daemon will start on login"),
    "install after a stop: turns start at login on",
  );
  check(!reinstall.out.includes("started directly"), "install after a stop: has launchd start the daemon");
  const reinstalled = startedPid(reinstall.out);
  const reinstalledJob = job();
  check(
    reinstalled !== null && reinstalledJob?.state === "running" && reinstalledJob.pid === reinstalled,
    `install after a stop: the daemon it started is launchd's (pid ${reinstalled}; launchd's ${reinstalledJob?.pid}, ${reinstalledJob?.state})`,
  );
  check(
    reinstalledJob?.runs === runsBeforeInstall + 1,
    `launchctl print: runs went from ${runsBeforeInstall} to ${reinstalledJob?.runs}`,
  );
  if (reinstalled && isOurWorker(reinstalled)) {
    await statusRunning(reinstalled, "install after a stop");
    const installAgain = engram(["install"], { env: launchdEnv });
    check(installAgain.status === 0, "install again: exits 0");
    check(!installAgain.out.includes("Engram daemon started"), "install again: starts no other daemon");
    check(
      job()?.pid === reinstalled && isDeepStrictEqual(ourWorkers(), [reinstalled]),
      `install again: the same daemon, and only it (${ourWorkers().join(", ")})`,
    );
  }
  engram(["stop"]);
  await waitFor("stop: no daemon runs", () => ourWorkers().length === 0);

  // ── A log that can't be written: launchd runs the daemon without it ────────
  await withoutItsLog(INSTALLED);

  // ── Marked as downloaded: launchd loads and runs it all the same ────────────
  bootout();
  await waitForGone("bootout: launchd lets go of the job");
  const mark = `0083;${Math.floor(Date.now() / 1000).toString(16)};Safari;`;
  for (const p of [PLIST, WORKER]) {
    const w = spawnSync(XATTR, ["-w", QUARANTINE, mark, p], { encoding: "utf-8" });
    if (w.status === 0) marked.push(p);
    check(w.status === 0 && spawnSync(XATTR, ["-p", QUARANTINE, p]).status === 0, `${p} is marked as downloaded`);
  }
  const markedLoad = bootstrap();
  check(markedLoad.status === 0, `launchctl bootstrap loads the marked plist${markedLoad.out ? ` (${markedLoad.out})` : ""}`);
  const markedPid = await waitForJob("launchd runs the marked worker");
  if (markedPid) await statusRunning(markedPid, "marked as downloaded");
  unmark();
  engram(["stop"]);
  await waitFor("stop: no daemon runs", () => ourWorkers().length === 0);

  // ── An older CLI's plist: engram start brings it up to date ─────────────────
  bootout();
  await waitForGone("bootout: launchd lets go of the job");
  writePlist(asV1(INSTALLED));
  const v1Load = bootstrap();
  check(v1Load.status === 0, `launchctl bootstrap loads an older CLI's plist${v1Load.out ? ` (${v1Load.out})` : ""}`);
  const v1 = await waitForJob("launchd runs the older plist's worker");
  if (v1) {
    check(commandOf(v1) === `${NODE} ${WORKER_MAIN}`, `ps: worker-main.js, as the older plist says (${commandOf(v1)})`);
    const old = await statusRunning(v1, "an older plist");
    check(
      autoStartLine(old.out)?.includes("outdated config, run 'engram install' to update") === true,
      `status: the plist is outdated (${autoStartLine(old.out)})`,
    );
    const stopV1 = engram(["stop"]);
    check(stopV1.out.includes(`Daemon stopped (pid ${v1})`), `stop: stops the older plist's daemon (pid ${v1})`);
  }
  await waitFor("no daemon runs", () => ourWorkers().length === 0);
  const start = engram(["start"]);
  check(start.status === 0, "start: exits 0");
  check(start.out.includes("Updated auto-start configuration (plist v2)"), "start: says it updated the plist");
  check(plistText() === INSTALLED, "start: the plist is the one install writes");
  const reloaded = job();
  check(isDeepStrictEqual(reloaded?.args, [NODE, WORKER]), `launchd has the new plist loaded (${JSON.stringify(reloaded?.args)})`);
  // launchd starts one as it loads the plist, and start one of its own: the
  // first to take the lock runs, and start reports that one.
  const started = startedPid(start.out);
  check(started !== null, `start: the daemon started (pid ${started})`);
  if (started) {
    await waitFor(`one daemon runs: pid ${started}`, () => isDeepStrictEqual(ourWorkers(), [started]));
    const now = await statusRunning(started, "updated by start");
    check(autoStartLine(now.out) === "Auto-start: enabled (launchd)", `status: up to date (${autoStartLine(now.out)})`);
  }

  // ── An older CLI's plist, its daemon running: engram install ───────────────
  engram(["stop"]);
  await waitFor("stop: no daemon runs", () => ourWorkers().length === 0);
  bootout();
  await waitForGone("bootout: launchd lets go of the job");
  writePlist(asV1(INSTALLED));
  check(bootstrap().status === 0, "launchctl bootstrap loads the older plist again");
  const v1b = await waitForJob("launchd runs the older plist's worker");
  const update = engram(["install"]);
  check(update.status === 0, "install: exits 0");
  check(update.out.includes("Auto-start enabled — daemon will start on login"), "install: says start at login is on");
  check(!update.out.includes("Engram daemon started"), "install: starts no daemon of its own");
  check(plistText() === INSTALLED, "install: the plist is the current one");
  const n = await waitForJob("launchd runs the new plist's worker in place of the older one", v1b ?? 0);
  if (!n) return;
  check(commandOf(n) === `${NODE} ${WORKER}`, `ps: worker.js (${commandOf(n)})`);
  await waitFor(`one daemon runs: pid ${n}`, () => isDeepStrictEqual(ourWorkers(), [n]));
  await statusRunning(n, "updated by install");

  // ── Switched off with launchctl: status says so, install switches it on ────
  const off = launchctl("disable", SERVICE);
  switchedOff = off.status === 0;
  check(off.status === 0, `launchctl disable${off.out ? ` (${off.out})` : ""}`);
  check(isOff(switchOf()), `print-disabled: the job is switched off (${switchOf()})`);
  const offStatus = engram(["status"]);
  check(
    autoStartLine(offStatus.out)?.startsWith("Auto-start: off — disabled in launchd") === true,
    `status: start at login is switched off in launchd (${autoStartLine(offStatus.out)})`,
  );
  const backOn = engram(["install"]);
  check(backOn.status === 0, "install: exits 0");
  check(backOn.out.includes("Auto-start enabled — daemon will start on login"), "install: says start at login is on");
  check(!backOn.out.includes("Engram daemon started"), "install: starts no daemon of its own");
  const now = switchOf();
  if (isOn(now)) switchedOff = false;
  check(isOn(now), `print-disabled: the job is switched back on (${now})`);
  const same = job();
  check(same?.state === "running" && same.pid === n, `launchd runs the same daemon (pid ${same?.pid}, was ${n})`);
  check(isDeepStrictEqual(ourWorkers(), [n]), `one daemon runs (${ourWorkers().join(", ")})`);

  // ── engram uninstall: launchd lets go of the job, and the daemon keeps running (engram#667)
  const uninstall = engram(["uninstall"]);
  check(uninstall.status === 0, "uninstall: exits 0");
  check(uninstall.out.includes("Auto-start disabled — launchd agent removed"), "uninstall: says the agent is removed");
  check(uninstall.out.includes(KEEPS_RUNNING), "uninstall: says the daemon keeps running");
  check(job() === null, "launchd no longer has the job");
  check(!there(PLIST), "the plist is gone");
  // Booting the job out stops the daemon launchd ran. Uninstall waits for
  // it to exit, and then starts one outside launchd, as on Linux and
  // Windows, where uninstall leaves the daemon running.
  check(!ourWorkers().includes(n), `the daemon launchd ran stopped with the job (pid ${n})`);
  const kept = await waitFor("uninstall: one daemon runs, started again outside launchd", () => {
    const pids = ourWorkers();
    return pids.length === 1 && pids[0] !== n ? pids[0] : 0;
  });
  if (kept) {
    await statusRunning(kept, "started again by uninstall");
    // As launchd's read it: the server from config.json. This command had
    // ENGRAM_BASE_URL set.
    const baseUrlSet = hasEnv(kept, "ENGRAM_BASE_URL");
    if (baseUrlSet === null) console.log("  (ps shows no environment for it: not checked)");
    else check(!baseUrlSet, "uninstall: the daemon it started has no ENGRAM_BASE_URL");
  }
  const stopKept = engram(["stop"]);
  check(stopKept.status === 0, "stop: exits 0");
  await waitFor("stop: the daemon uninstall started stops", () => ourWorkers().length === 0);
  const none = engram(["status"]);
  check(none.out.includes("Status: stopped"), "status: stopped");
  check(autoStartLine(none.out) === null, `status: nothing about start at login (${autoStartLine(none.out)})`);

  // ── engram start --install: start at login first, then launchd starts the daemon (engram#641)
  const withInstall = engram(["start", "--install"], { env: launchdEnv });
  check(withInstall.status === 0, "start --install: exits 0");
  const enabledAt = withInstall.out.indexOf("Auto-start enabled — daemon will start on login");
  check(
    enabledAt >= 0 && withInstall.out.indexOf("Engram daemon started") > enabledAt,
    "start --install: turns start at login on, and then the daemon is started",
  );
  check(plistText() === INSTALLED, "start --install: the plist is the one install writes");
  const installedPid = startedPid(withInstall.out);
  const installedJob = job();
  check(
    installedPid !== null && installedJob?.state === "running" && installedJob.pid === installedPid,
    `start --install: the daemon is launchd's (pid ${installedPid}; launchd's ${installedJob?.pid})`,
  );
  // Loading the job started the daemon; kickstart, without -k, left it running.
  check(installedJob?.runs === 1, `launchctl print: launchd started it once (runs ${installedJob?.runs})`);
  if (installedPid) {
    await waitFor(`one daemon runs: pid ${installedPid}`, () => isDeepStrictEqual(ourWorkers(), [installedPid]));
  }
  const removed = engram(["uninstall"]);
  check(removed.status === 0, "uninstall: exits 0");
  check(removed.out.includes(KEEPS_RUNNING), "uninstall: says the daemon keeps running");
  await waitFor("uninstall: launchd lets go of the job", () => job() === null);
  await waitFor("uninstall: one daemon runs, started again outside launchd", () => {
    const pids = ourWorkers();
    return pids.length === 1 && pids[0] !== installedPid ? pids[0] : 0;
  });
  engram(["stop"]);
  await waitFor("stop: no daemon of this test runs", () => ourWorkers().length === 0);

  // ── A plist from before engram#616, which launchd can't load ───────────────
  mkdirSync(dirname(PLIST), { recursive: true });
  writePlist(unescaped(INSTALLED));
  const refused = bootstrap();
  check(refused.status !== 0, `launchd can't load it (${refused.out.split("\n")[0]})`);
  if (job() !== null) {
    check(false, "launchd loaded the plist with its paths unescaped");
    bootout();
    await waitForGone("bootout: launchd lets go of the job");
  }
  const broken = engram(["status"]);
  check(broken.out.includes("Status: stopped"), "status: stopped");
  check(
    autoStartLine(broken.out)?.includes("broken, run 'engram install' to repair") === true,
    `status: the plist is broken (${autoStartLine(broken.out)})`,
  );
  const repair = engram(["start"]);
  check(repair.status === 0, "start: exits 0");
  check(repair.out.includes("Updated auto-start configuration (plist v2)"), "start: says it rewrote the plist");
  check(plistText() === INSTALLED, "start: the plist is the one install writes");
  const repaired = job();
  check(isDeepStrictEqual(repaired?.args, [NODE, WORKER]), `launchd has it loaded (${JSON.stringify(repaired?.args)})`);
  const after = startedPid(repair.out);
  check(after !== null, `start: the daemon started (pid ${after})`);
  if (after) {
    await waitFor(`one daemon runs: pid ${after}`, () => isDeepStrictEqual(ourWorkers(), [after]));
    await statusRunning(after, "repaired by start");
  }

  // ── Done: uninstall, and stop the daemon it keeps running ─────────────────
  engram(["uninstall"]);
  if (ourWorkers().length > 0) engram(["stop"]);
  await waitFor("no daemon of this test runs", () => ourWorkers().length === 0);
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
