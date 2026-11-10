#!/usr/bin/env node
/**
 * Start at login on Linux (engram#615), under the real systemd. The unit
 * tests check the unit's text and each systemctl call against a stub; this
 * gives the unit `engram install` writes to the user's own service manager,
 * and checks:
 *
 *   - `engram install` writes ~/.config/systemd/user/engram.service, 0644,
 *     enables it (default.target.wants) and has systemd start the daemon
 *     (engram#689). `systemd-analyze verify` finds nothing wrong with the
 *     unit.
 *   - When the user's service manager starts, as at login, it starts the
 *     daemon: this Node and this build's worker, word for word, though the
 *     paths of Node and of the home hold quotes, a backslash, `$HOME`, `%h`
 *     and a letter outside ASCII. ~/.engram and daemon.log, removed before,
 *     are made again 0700 and 0600, and `engram status` finds the daemon.
 *   - A daemon killed outright is started again; one `engram stop` stops,
 *     isn't.
 *   - `engram start` has systemd start the daemon too (engram#689), and
 *     systemd starts that one again when it is killed outright;
 *     `systemctl --user start` leaves a daemon that runs as it is. With
 *     ENGRAM_BASE_URL set, which systemd's daemon wouldn't have, `engram
 *     start` starts the daemon itself, and `engram start` and `engram status`
 *     then say systemd won't restart it after a crash. Refused by systemd,
 *     as after five starts in five minutes, `engram start` starts the daemon
 *     itself and says why.
 *   - `engram status` says when the unit was disabled with systemctl, and
 *     `engram install` turns it back on without starting a second daemon.
 *   - `engram uninstall` disables and removes the unit and leaves the daemon
 *     running, and `engram stop` stops it.
 *
 * Usage, on a Linux CI runner, after `pnpm build`:
 *
 *   ENGRAM_E2E_SYSTEMD=1 node scripts/e2e-systemd.mjs
 *
 * It writes to the real ~/.config/systemd/user and restarts the user's
 * service manager with sudo, so it runs only when asked to and only where
 * CI=true, and refuses if there is an engram.service already.
 * .github/workflows/pr.yml gives the runner's user a service manager of its
 * own (lingering). The daemon runs signed out, under a temporary home, with
 * no key and a server address that nothing answers on, set in config.json.
 * It signals only the workers it started: the copy of Node it makes, running
 * this build's worker.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

if (process.env.ENGRAM_E2E_SYSTEMD !== "1") {
  console.log("skipped: set ENGRAM_E2E_SYSTEMD=1 to run it (CI only: it changes the user's systemd setup)");
  process.exit(0);
}
if (process.platform !== "linux" || process.env.CI !== "true") {
  console.error(
    "refusing: this writes to ~/.config/systemd/user and restarts the user's service manager, " +
      "so it runs only on a Linux CI runner (CI=true)",
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

/** A server address nothing answers on: the daemon has no key anyway. */
const NOWHERE = "http://127.0.0.1:9";

/** systemctl --user, for the runner's user, as this test runs. */
function systemctl(...args) {
  const r = spawnSync("systemctl", ["--user", ...args], { encoding: "utf-8", timeout: 30_000 });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? r.error.message : ""}`.trim() };
}

const version = systemctl("show", "--property=Version");
if (version.status !== 0) {
  console.error(`no systemd user session: ${version.out}`);
  console.error("  (pr.yml starts one with 'loginctl enable-linger' and sets XDG_RUNTIME_DIR)");
  process.exit(1);
}
console.log(`user service manager: ${version.out}`);

// Where the service manager reads the user's units: the CLI is given the same
// XDG_CONFIG_HOME, so it writes the unit there and finds the link `enable`
// makes. It is ~/.config of the user's own home, whatever HOME the CLI has.
const managerConfigHome = /^XDG_CONFIG_HOME=(\/.*)$/m.exec(systemctl("show-environment").out)?.[1];
const CONFIG_HOME = managerConfigHome ?? join(userInfo().homedir, ".config");
const UNIT_DIR = join(CONFIG_HOME, "systemd", "user");
const UNIT = join(UNIT_DIR, "engram.service");
const WANTS_DIR = join(UNIT_DIR, "default.target.wants");
const WANTS = join(WANTS_DIR, "engram.service");
const DROP_IN = join(UNIT_DIR, "engram.service.d");

const there = (p) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
for (const p of [UNIT, WANTS, DROP_IN]) {
  if (there(p)) {
    console.error(`${p} is there already: refusing to touch it`);
    process.exit(1);
  }
}
const paths = spawnSync("systemd-analyze", ["--user", "unit-paths"], { encoding: "utf-8", timeout: 30_000 });
if (paths.status === 0 && !paths.stdout.split("\n").includes(UNIT_DIR)) {
  console.error(`the user's service manager doesn't read units from ${UNIT_DIR}:\n${paths.stdout}`);
  process.exit(1);
}
/** Folders this test may make, so that cleanup removes only those it made. */
const MADE = [join(CONFIG_HOME, "systemd"), UNIT_DIR, WANTS_DIR].filter((d) => !there(d));

// ── The temporary home, and Node at an odd path ─────────────────────────────
// Every character systemd or the shell in ExecStart could take for something
// else, but ':' (PATH's separator). Node is copied into a folder with the
// same name, so its path in the unit has them too.
process.umask(0o022);
const root = realpathSync(mkdtempSync(join(tmpdir(), "e2e-sd-")));
const ODD = `O'Brien "Q" \\ $HOME %h ü`;
const home = join(root, ODD);
const NODE_DIR = join(root, `node ${ODD}`);
const NODE = join(NODE_DIR, "node");
mkdirSync(home);
mkdirSync(NODE_DIR);
copyFileSync(process.execPath, NODE);
chmodSync(NODE, 0o755);
const ENGRAM_DIR = join(home, ".engram");
const LOG_FILE = join(ENGRAM_DIR, "daemon.log");
if (Buffer.byteLength(join(ENGRAM_DIR, "daemon.sock")) > 100) {
  console.error(`the daemon's socket path would be too long under ${root}: set TMPDIR to a shorter folder`);
  rmSync(root, { recursive: true, force: true });
  process.exit(2);
}
// The server address goes in config.json, where the daemon systemd starts
// reads it as the CLI does: with ENGRAM_BASE_URL set, which systemd's daemon
// wouldn't have, `engram start` starts the daemon itself (engram#689).
// ~/.engram as others can read it, which the daemon puts right.
const CONFIG_FILE = join(ENGRAM_DIR, "config.json");
function writeConfig() {
  mkdirSync(ENGRAM_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, `${JSON.stringify({ baseUrl: NOWHERE })}\n`, { mode: 0o600 });
}
mkdirSync(ENGRAM_DIR, { mode: 0o755 });
writeConfig();
const UNIT_PATH_ENV = `${NODE_DIR}:/usr/local/bin:/usr/bin:/bin`;
const env = {
  PATH: UNIT_PATH_ENV,
  HOME: home,
  XDG_CONFIG_HOME: CONFIG_HOME,
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
  DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
  ENGRAM_NO_AUTOCAPTURE: "1",
  LANG: "C.UTF-8",
};
for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
/** The same with ENGRAM_BASE_URL set: `engram start` starts the daemon itself (engram#689). */
const directEnv = { ...env, ENGRAM_BASE_URL: NOWHERE };

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) failures++;
  return ok;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Polls `test` until it gives something truthy. */
async function waitFor(what, test, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = test();
    if (v) return v;
    await sleep(250);
  }
  check(false, `${what} (gave up after ${ms / 1000}s)`);
  return null;
}

/** Run the built CLI as a user would, under this copy of Node. */
function engram(args, { quiet = false, env: environment = env } = {}) {
  const r = spawnSync(NODE, [CLI, ...args], { env: environment, cwd: root, encoding: "utf-8", timeout: 90_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "");
  if (!quiet) {
    const set = environment.ENGRAM_BASE_URL ? `ENGRAM_BASE_URL=${environment.ENGRAM_BASE_URL} ` : "";
    console.log(`\n$ ${set}engram ${args.join(" ")}  (exit ${r.status})`);
    for (const line of out.trimEnd().split("\n")) console.log(`  │ ${line}`);
  }
  return { status: r.status, out };
}

const show = (prop) => systemctl("show", `--property=${prop}`, "--value", "engram.service").out;
const activeState = () => show("ActiveState");
const mainPid = () => Number(show("MainPID")) || 0;
const restarts = () => Number(show("NRestarts")) || 0;
const isEnabled = () => systemctl("is-enabled", "engram.service").out;

function cmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf-8").split("\0").slice(0, -1);
  } catch {
    return null;
  }
}
function environ(pid) {
  try {
    return readFileSync(`/proc/${pid}/environ`, "utf-8").split("\0").filter(Boolean);
  } catch {
    return null;
  }
}
/** `pid` is a worker this test started: this copy of Node, running this build's worker. */
const isOurWorker = (pid) => pid > 0 && isDeepStrictEqual(cmdline(pid), [NODE, WORKER]);
const ourWorkers = () =>
  readdirSync("/proc")
    .filter((d) => /^\d+$/.test(d))
    .map(Number)
    .filter(isOurWorker);

/** Where `p` leads, through any links; null when it leads nowhere. */
const resolves = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};
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
/** What start and status say of a daemon systemd doesn't run (engram#692). */
const outsideLine = (pid) =>
  `The running daemon (pid ${pid}) wasn't started by systemd, so systemd won't restart it after a crash`;

/** `engram status`, once the daemon at `pid` answers; printed. */
async function statusRunning(pid, what) {
  const ok = await waitFor(`${what}: status finds the daemon (pid ${pid})`, () =>
    engram(["status"], { quiet: true }).out.includes(`Status: running (pid ${pid})`),
  );
  return { ok: Boolean(ok), ...engram(["status"]) };
}

/** systemd's MainPID, once it is a worker of ours that isn't `not`. */
const waitForService = (what, not, ms) =>
  waitFor(what, () => {
    const pid = mainPid();
    return activeState() === "active" && pid !== not && isOurWorker(pid) ? pid : 0;
  }, ms);

function cleanup() {
  systemctl("stop", "engram.service");
  rmSync(UNIT, { force: true });
  rmSync(WANTS, { force: true });
  rmSync(DROP_IN, { recursive: true, force: true });
  for (const d of [...MADE].reverse()) {
    try {
      rmdirSync(d);
    } catch {
      // not empty: something else is in it
    }
  }
  systemctl("daemon-reload");
  systemctl("reset-failed", "engram.service");
  const left = ourWorkers();
  for (const pid of left) process.kill(pid, "SIGKILL");
  check(left.length === 0, `no worker of this test left running${left.length ? ` (killed ${left.join(", ")})` : ""}`);
  rmSync(root, { recursive: true, force: true });
}
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

function diagnostics() {
  console.log("\n── diagnostics ──");
  const runs = [
    ["systemctl", ["--user", "status", "engram.service", "--no-pager", "--full"]],
    ["journalctl", ["--user", "--no-pager", "-n", "80", "-u", "engram.service"]],
    ["sudo", ["-n", "journalctl", "--no-pager", "-n", "80", `_SYSTEMD_USER_UNIT=engram.service`]],
  ];
  for (const [cmd, args] of runs) {
    const r = spawnSync(cmd, args, { encoding: "utf-8", timeout: 30_000 });
    console.log(`\n$ ${cmd} ${args.join(" ")}\n${r.stdout ?? ""}${r.stderr ?? ""}`);
  }
  console.log(`\n── daemon.log, last 40 lines ──\n${logText().split("\n").slice(-40).join("\n")}`);
}

/**
 * `engram start` has systemd start the daemon (engram#689). Run with the
 * unit enabled and no daemon running: the last one systemd ran was stopped
 * by `engram stop`, an exit Restart=on-failure leaves be.
 */
async function startThroughSystemd() {
  // The test's own: systemd's count of starts begins again here, so that the
  // refusal below comes when it is meant to (StartLimitBurst).
  systemctl("reset-failed", "engram.service");

  // ── engram start: systemd starts the daemon ───────────────────────────────
  const start = engram(["start"]);
  check(start.status === 0, "start: exits 0");
  check(!start.out.includes("started directly"), "start: has systemd start the daemon");
  const started = startedPid(start.out);
  check(
    started !== null && isOurWorker(started) && activeState() === "active" && mainPid() === started,
    `start: the daemon it started is systemd's (pid ${started}; systemd's ${mainPid()}, ${activeState()})`,
  );
  if (!started || !isOurWorker(started)) return;

  // What start counts on when the daemon doesn't answer yet: systemctl start
  // leaves a unit that runs as it is.
  const startActive = systemctl("start", "engram.service");
  check(
    startActive.status === 0 && mainPid() === started && isDeepStrictEqual(ourWorkers(), [started]),
    `systemctl --user start, the daemon running: leaves it as it is (pid ${mainPid()}; ${ourWorkers().join(", ")})`,
  );

  const twice = engram(["start"]);
  check(twice.out.includes(`Daemon already running (pid ${started})`), `start again: the daemon runs (pid ${started})`);
  check(!twice.out.includes("wasn't started by systemd"), "start again: says nothing of systemd, which runs it");
  const runningStatus = engram(["status"]);
  check(
    autoStartLine(runningStatus.out) === "Auto-start: enabled (systemd)" &&
      !runningStatus.out.includes("wasn't started by systemd"),
    `status: start at login is on, nothing said of systemd, which runs the daemon (${autoStartLine(runningStatus.out)})`,
  );

  // Killed outright: systemd starts it again, as it does the one it starts at login.
  const before = restarts();
  if (isOurWorker(started)) process.kill(started, "SIGKILL");
  const respawned = await waitForService("systemd starts the daemon start had it start again after it was killed", started, 60_000);
  if (!respawned) return;
  check(restarts() === before + 1, `NRestarts went from ${before} to ${restarts()}`);
  await statusRunning(respawned, "started again");
  const stopRespawned = engram(["stop"]);
  check(stopRespawned.out.includes(`Daemon stopped (pid ${respawned})`), `stop: stopped pid ${respawned}`);
  await waitFor("engram.service is inactive", () => activeState() === "inactive", 20_000);

  // ── With ENGRAM_BASE_URL set, start starts the daemon itself ──────────────
  // A start after that says systemd doesn't run it, and how to hand it over.
  const direct = engram(["start"], { env: directEnv });
  const directPid = startedPid(direct.out);
  check(
    direct.status === 0 && directPid !== null && isOurWorker(directPid),
    `start with ENGRAM_BASE_URL set: starts the daemon (pid ${directPid})`,
  );
  check(
    activeState() === "inactive" && mainPid() === 0,
    `start with ENGRAM_BASE_URL set: systemd doesn't run it (engram.service is ${activeState()})`,
  );
  const outside = engram(["start"]);
  check(outside.out.includes(`Daemon already running (pid ${directPid})`), `start: the daemon runs (pid ${directPid})`);
  check(outside.out.includes(outsideLine(directPid)), "start: says systemd won't restart it after a crash");
  const outsideStatus = engram(["status"]);
  check(
    outsideStatus.out.includes(`Auto-start: enabled (systemd)\n  ${outsideLine(directPid)}`),
    "status: says it too, under its Auto-start line (engram#692)",
  );
  check(activeState() === "inactive", `start: leaves it running, and systemd's unit inactive (${activeState()})`);
  engram(["stop"]);
  await waitFor("stop: no daemon runs", () => ourWorkers().length === 0, 10_000);

  // ── systemd refuses: start starts the daemon itself, and says why ─────────
  // Started and stopped until systemd refuses, as it does more than
  // StartLimitBurst=5 starts within StartLimitIntervalSec=300.
  let refusal = null;
  for (let i = 0; i < 6 && refusal === null; i++) {
    const r = systemctl("start", "engram.service");
    if (r.status === 0) systemctl("stop", "engram.service");
    else refusal = r.out;
  }
  check(
    refusal !== null && activeState() === "failed",
    `systemd refuses to start it again (engram.service is ${activeState()}): ${refusal?.split("\n")[0]}`,
  );
  const refused = engram(["start"]);
  check(refused.status === 0, "start, systemd refusing: exits 0");
  check(
    /systemd couldn't start the daemon \(systemctl: Job for engram\.service failed[^\n]*\), so it is started directly, and won't be restarted after a crash\./.test(
      refused.out,
    ),
    "start, systemd refusing: starts the daemon itself, says why, and that it won't be restarted after a crash",
  );
  const refusedPid = startedPid(refused.out);
  check(
    refusedPid !== null && isOurWorker(refusedPid) && mainPid() === 0,
    `start, systemd refusing: the daemon runs (pid ${refusedPid}), not under systemd (${activeState()})`,
  );
  engram(["stop"]);
  await waitFor("stop: no daemon runs", () => ourWorkers().length === 0, 10_000);
  // The test's own: systemd starts it again from here.
  systemctl("reset-failed", "engram.service");
  check(activeState() === "inactive", `systemctl reset-failed: engram.service is ${activeState()}`);
}

try {
  // The test's own: the daemon under systemd gets the same unreachable
  // server, config.json or not (it goes with ~/.engram below).
  mkdirSync(DROP_IN, { recursive: true });
  writeFileSync(join(DROP_IN, "e2e.conf"), `[Service]\nEnvironment=ENGRAM_BASE_URL=${NOWHERE}\n`);

  // ── engram install: systemd starts the daemon (engram#689) ────────────────
  const install = engram(["install"]);
  check(install.status === 0, "install: exits 0");
  check(
    install.out.includes("Auto-start enabled — daemon will start when you log in (systemd)"),
    "install: says start at login is on, through systemd",
  );
  check(install.out.includes(`Unit: ${UNIT}`), `install: names the unit, ${UNIT}`);
  check(!install.out.includes("started directly"), "install: has systemd start the daemon");
  const installed = startedPid(install.out);
  check(
    installed !== null && isOurWorker(installed) && activeState() === "active" && mainPid() === installed,
    `install: the daemon it started is systemd's (pid ${installed}; systemd's ${mainPid()}, ${activeState()})`,
  );
  check(modeOf(UNIT) === "644", `the unit is 0644 (${modeOf(UNIT)})`);
  check(resolves(WANTS) !== null && resolves(WANTS) === resolves(UNIT), "enabled: default.target.wants links to the unit");
  check(isEnabled() === "enabled", `systemctl is-enabled: ${isEnabled()}`);
  const madePrivate = await waitFor(
    "~/.engram made 0700 from 0755, daemon.log 0600",
    () => modeOf(ENGRAM_DIR) === "700" && modeOf(LOG_FILE) === "600",
  );
  if (madePrivate) check(true, "~/.engram made 0700 from 0755, daemon.log 0600");
  else console.log(`      ~/.engram ${modeOf(ENGRAM_DIR)}, daemon.log ${modeOf(LOG_FILE)}`);

  const verify = spawnSync("systemd-analyze", ["--user", "verify", UNIT], { encoding: "utf-8", timeout: 60_000 });
  const verdict = `${verify.stdout ?? ""}${verify.stderr ?? ""}`.trim();
  const aboutUnit = verdict.split("\n").filter((l) => l.includes("engram.service"));
  check(verify.status === 0 && aboutUnit.length === 0,
    `systemd-analyze verify: nothing wrong with the unit${verdict ? `\n${verdict}` : ""}`);

  const status1 = await statusRunning(installed, "after install");
  check(status1.out.includes("Auto-start: enabled (systemd)") && !/broken|outdated/.test(status1.out),
    "status: start at login is on, through systemd");
  check(!status1.out.includes("wasn't started by systemd"), "status: says nothing of systemd, which runs the daemon");

  // ── As at login: the service manager starts the daemon ────────────────────
  const stop1 = engram(["stop"]);
  check(stop1.status === 0 && stop1.out.includes(`Daemon stopped (pid ${installed})`), `stop: stopped pid ${installed}`);
  await waitFor("engram.service is inactive", () => activeState() === "inactive", 20_000);
  check(ourWorkers().length === 0, "no worker runs");
  // The shell in ExecStart makes them again, private (engram#627).
  rmSync(ENGRAM_DIR, { recursive: true, force: true });

  const uid = process.getuid();
  const relogin = spawnSync("sudo", ["-n", "systemctl", "restart", `user@${uid}.service`], {
    encoding: "utf-8",
    timeout: 120_000,
  });
  check(relogin.status === 0, `the user's service manager started again (user@${uid}.service)${
    relogin.status === 0 ? "" : `: ${relogin.stderr}`}`);
  await waitFor("the service manager answers", () => systemctl("show", "--property=Version").status === 0, 30_000);
  const atLogin = await waitForService("systemd starts engram.service", 0, 60_000);
  if (atLogin) {
    check(true, `systemd ran ${JSON.stringify([NODE, WORKER])} (pid ${atLogin})`);
    const vars = environ(atLogin) ?? [];
    for (const v of [`HOME=${home}`, `PATH=${UNIT_PATH_ENV}`, "ENGRAM_UNIT_VERSION=1", `ENGRAM_BASE_URL=${NOWHERE}`]) {
      check(vars.includes(v), `its environment has ${v}`);
    }
    await waitFor("daemon.log says it started", () => logText().includes(`daemon started (pid ${atLogin})`));
    check(modeOf(ENGRAM_DIR) === "700" && modeOf(LOG_FILE) === "600",
      `~/.engram made again 0700 (${modeOf(ENGRAM_DIR)}), daemon.log 0600 (${modeOf(LOG_FILE)})`);
    writeConfig(); // gone with ~/.engram
    const status2 = await statusRunning(atLogin, "started by systemd");
    check(status2.ok && status2.out.includes("Auto-start: enabled (systemd)"), "status: running, start at login on");

    // ── Killed outright: started again ───────────────────────────────────────
    const before = restarts();
    if (isOurWorker(atLogin)) process.kill(atLogin, "SIGKILL");
    const again = await waitForService("systemd starts it again after it was killed", atLogin, 60_000);
    if (again) {
      check(restarts() === before + 1, `NRestarts went from ${before} to ${restarts()}`);
      await statusRunning(again, "started again");

      // ── engram stop: not started again ─────────────────────────────────────
      const stop2 = engram(["stop"]);
      check(stop2.status === 0 && stop2.out.includes(`Daemon stopped (pid ${again})`), `stop: stopped pid ${again}`);
      await waitFor("engram.service is inactive", () => activeState() === "inactive", 20_000);
      const stopped = restarts();
      await sleep(13_000); // longer than RestartSec
      check(activeState() === "inactive" && restarts() === stopped && ourWorkers().length === 0,
        `not started again 13s later (${activeState()}, ${ourWorkers().length} running)`);

      await startThroughSystemd();
    }
  }

  // ── systemctl start, disable; engram install turns it back on ─────────────
  const start = systemctl("start", "engram.service");
  check(start.status === 0, `systemctl --user start engram.service${start.out ? `: ${start.out}` : ""}`);
  const onDemand = await waitForService("systemctl start starts it", 0, 30_000);
  if (onDemand) await statusRunning(onDemand, "started with systemctl");

  const disable = systemctl("disable", "engram.service");
  check(disable.status === 0 && !there(WANTS), "systemctl --user disable removes the link");
  const status3 = engram(["status"]);
  check(status3.out.includes("Auto-start: off — disabled with systemctl"), "status: says it was disabled with systemctl");

  const reinstall = engram(["install"]);
  check(reinstall.status === 0 && reinstall.out.includes("Auto-start enabled"), "install again: start at login is back on");
  check(!reinstall.out.includes("Engram daemon started"), "install again: starts no second daemon");
  check(!reinstall.out.includes("wasn't started by systemd"), "install again: says nothing of systemd, which runs it");
  check(isEnabled() === "enabled" && there(WANTS), `enabled again (${isEnabled()})`);
  check(ourWorkers().length === 1 && mainPid() === onDemand, `one worker runs, still pid ${onDemand} (${ourWorkers().join(", ")})`);

  // ── engram uninstall, then stop ────────────────────────────────────────────
  const uninstall = engram(["uninstall"]);
  check(uninstall.status === 0 && uninstall.out.includes("Auto-start disabled — the systemd unit is removed"),
    "uninstall: says the unit is removed");
  check(uninstall.out.includes("The daemon keeps running until 'engram stop' or sign-out."),
    "uninstall: says the daemon keeps running");
  check(!there(UNIT) && !there(WANTS), "the unit and its link are gone");
  check(isEnabled() !== "enabled", `systemctl no longer has it enabled (${isEnabled() || "nothing"})`);
  check(isOurWorker(onDemand), `the daemon keeps running (pid ${onDemand})`);
  const status4 = await statusRunning(onDemand, "after uninstall");
  check(!status4.out.includes("Auto-start:"), "status: no start at login");

  const stop3 = engram(["stop"]);
  check(stop3.status === 0 && stop3.out.includes(`Daemon stopped (pid ${onDemand})`), `stop: stopped pid ${onDemand}`);
  await waitFor("no worker runs", () => ourWorkers().length === 0, 10_000);
} finally {
  if (failures > 0) diagnostics();
  cleanup();
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
