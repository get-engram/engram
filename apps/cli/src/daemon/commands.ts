import { execSync, execFileSync, type ChildProcess } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { bold, dim, plural, red } from "../output.js";
import { loadConfig, saveConfig } from "../config.js";
import { writePrivateFileSync } from "../private-files.js";
import {
  readStatus,
  syncErrorSummary,
  captureErrorSummary,
  deleteRefusedSummary,
  type SyncStatus,
} from "./status.js";
import { formatWait } from "./backoff.js";
import { ALL_ADAPTERS } from "./adapters.js";
import {
  ENGRAM_DIR,
  LOG_FILE,
  START_WAIT_MS,
  loginStartPath,
  prepareLogSync,
  spawnSupervisor,
  spawnWorker,
  workerPath,
} from "./launch.js";
import {
  STOPPING_WAIT_MS,
  STOP_FILE,
  VERSION,
  alive,
  identifyProcess,
  pidInFile,
  probeDaemon,
  removePidFileIf,
  type Probe,
} from "./instance.js";
import {
  UNIT_VERSION,
  generateUnit,
  installUnit,
  readUnit,
  removeUnit,
  rewriteUnit,
  systemctlPath,
  systemdReachable,
  unitPath,
  type UnitState,
} from "./systemd.js";

/** Render the per-host capture status (engram#261). `signedOut`: the
 *  daemon runs without a key, so nothing is captured (engram#594). */
function printHostStatus(signedOut = false): void {
  console.log(`${dim("Hosts:")}`);
  for (const a of ALL_ADAPTERS) {
    const on = a.available();
    const mark = on ? "✓" : "·";
    const state = on ? (signedOut ? "paused (signed out)" : "capturing") : "not installed";
    console.log(`  ${mark} ${a.label.padEnd(14)} ${dim(state)}`);
  }
}

const DB_FILE = join(ENGRAM_DIR, "daemon.db");
const PLIST_NAME = "app.getengram.daemon";
const PLIST_DIR = join(homedir(), "Library", "LaunchAgents");
const PLIST_PATH = join(PLIST_DIR, `${PLIST_NAME}.plist`);

// Bump when generatePlist() changes in a way existing installs must pick up.
// A plist is written once at install time and never revisited, so upgrading
// the CLI alone does NOT fix a defect that lives in the plist — the stale file
// keeps launching the old thing. Every machine installed before v2 is still
// pointing launchd at `worker-main.js`, the pre-0.4.2 entry point that has no
// ABI preflight, which is why the self-heal shipped in 0.4.2 has never once
// run on them (engram#469).
//
// v2: launch `worker.js` (preflight bootstrap) and give the job a PATH.
const PLIST_VERSION = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** What `engram start`, `stop` and `status` find (engram#612). */
type DaemonFound =
  /**
   * A daemon answers on its socket, or, with nothing answering, launchd or
   * the PID file names a process confirmed to be one. `older`: that one
   * has no socket, so it is from before engram#612.
   */
  | {
      state: "running";
      pid: number;
      version?: string;
      ready: boolean;
      older: boolean;
      /** From its answer: which server it is, and whether it stops when STOP_FILE asks it to (engram#613). */
      id?: string;
      stopFile?: boolean;
    }
  /** It answers, and is shutting down: finishing a send, then exiting. */
  | { state: "stopping"; pid: number }
  /**
   * Something holds the socket and doesn't answer: most often a daemon
   * whose preflight is rebuilding better-sqlite3, which keeps it busy for a
   * minute or two. `pid`: when launchd or the PID file names the daemon.
   */
  | { state: "unresponsive"; pid: number | null }
  | { state: "stopped" };

function fromAnswer(probe: Probe): DaemonFound | null {
  if (probe.state !== "answered") return null;
  const { info } = probe;
  if (info.stopping) return { state: "stopping", pid: info.pid };
  return {
    state: "running",
    pid: info.pid,
    version: info.version,
    ready: info.ready,
    older: false,
    id: info.id,
    stopFile: info.stopFile,
  };
}

/**
 * Find the daemon. It answers on ~/.engram/daemon.sock (a named pipe on
 * Windows) with its PID. The PID file alone is never trusted: one left by a
 * daemon that didn't exit cleanly can name a PID that has since gone to
 * another program, which this used to report as the daemon and `engram stop`
 * signalled.
 */
async function findDaemon(timeoutMs?: number): Promise<DaemonFound> {
  const probe = await probeDaemon({ timeoutMs });
  const answered = fromAnswer(probe);
  if (answered) return answered;
  if (probe.state === "silent") {
    // The PID file is left as it is: a daemon busy starting wrote it.
    return { state: "unresponsive", pid: readLaunchdPid() ?? confirmedPidFile(false) };
  }
  // Nothing answers. A daemon from before engram#612 has no socket, but
  // launchd, or its PID file confirmed, still finds it. (A daemon since
  // listens before it writes the PID file.) Where no socket can be used
  // (probe "unavailable"), that is how every daemon is found.
  const pid = readLaunchdPid() ?? confirmedPidFile(true);
  if (pid === null) return { state: "stopped" };
  return { state: "running", pid, ready: true, older: probe.state === "none" };
}

/**
 * The daemon the PID file names, when that process is confirmed to be it
 * (see identifyProcess). `tidy`: remove a file that names a process that has
 * exited, or another program.
 */
function confirmedPidFile(tidy: boolean): number | null {
  const pid = pidInFile();
  if (pid === null || pid === process.pid) return null;
  if (!alive(pid)) {
    if (tidy) removePidFileIf(pid);
    return null;
  }
  const what = identifyProcess(pid);
  if (what === "other" && tidy) removePidFileIf(pid);
  return what === "daemon" ? pid : null;
}

/** "Daemon already running", for a start that finds one. */
function printAlreadyRunning(found: Extract<DaemonFound, { state: "running" | "unresponsive" }>): void {
  const pid = found.pid === null ? "" : ` (pid ${found.pid})`;
  if (found.state === "unresponsive") {
    console.log(`Daemon already running${pid}, but it isn't answering right now`);
    console.log(dim(`  It may be busy, or still starting. Its log: ${LOG_FILE}`));
    return;
  }
  console.log(`Daemon already running${pid}`);
  printVersionHint(found);
}

/** When the running daemon isn't this CLI's version, how to switch to it. */
function printVersionHint(found: { version?: string; older: boolean }): void {
  if (found.older) {
    console.log(dim("  It's from an older version of Engram: run 'engram stop' and then 'engram start' to update it."));
  } else if (found.version && VERSION !== "unknown" && found.version !== VERSION) {
    console.log(
      dim(`  It runs version ${found.version}, and this CLI is ${VERSION}: run 'engram stop' and then 'engram start' to switch.`),
    );
  }
}

/**
 * Wait, up to STOPPING_WAIT_MS, for a daemon that is stopping to exit, and
 * then look again. Its exit, not its socket: it lets the socket go a moment
 * before it exits, and in that moment launchd still names it.
 */
async function whileStopping(found: DaemonFound): Promise<DaemonFound> {
  if (found.state !== "stopping") return found;
  console.log(dim(`Waiting for the daemon that is stopping (pid ${found.pid}) to finish...`));
  return (await exited(found.pid)) ? findDaemon() : found;
}

/**
 * Wait, up to STOPPING_WAIT_MS, for `pid` to exit; true once it has.
 * `slow`: said once, when it takes more than two seconds.
 */
async function exited(pid: number, slow?: () => void): Promise<boolean> {
  const start = Date.now();
  while (alive(pid)) {
    const waited = Date.now() - start;
    if (waited >= STOPPING_WAIT_MS) return false;
    if (slow && waited >= 2_000) {
      slow();
      slow = undefined;
    }
    await sleep(100);
  }
  return true;
}

function readLaunchdPid(): number | null {
  if (!isLaunchdInstalled()) return null;
  try {
    const output = execSync(`launchctl list ${PLIST_NAME} 2>/dev/null`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const match = output.match(/"PID"\s*=\s*(\d+)/);
    if (match) return parseInt(match[1], 10);
    // Also check the tabular format: PID\tStatus\tLabel
    const lines = output.trim().split("\n");
    for (const line of lines) {
      const parts = line.split("\t");
      if (parts.length >= 1) {
        const pid = parseInt(parts[0], 10);
        if (!isNaN(pid) && pid > 0) return pid;
      }
    }
  } catch {
    // not loaded
  }
  return null;
}

export async function daemonStart(
  _args: string[],
  flags: Record<string, string>,
): Promise<void> {
  await recordCaptureIntent("on");
  // `engram stop` and then `engram start`: the last daemon may still be
  // finishing a send. A worker started now would only wait for it too.
  const found = await whileStopping(await findDaemon());
  if (found.state === "stopping") {
    console.error(red(`The daemon is still stopping (pid ${found.pid}). Run 'engram start' again in a moment.`));
    process.exitCode = 1;
    return;
  }
  if (found.state === "running" || found.state === "unresponsive") {
    printAlreadyRunning(found);
    // --install still asks for start at login (engram#602). On macOS,
    // loading the launchd agent starts a worker there and then, which finds
    // this daemon and exits (engram#612).
    if ("install" in flags) await enableStartAtLogin(true);
    return;
  }

  const foreground = "foreground" in flags || "f" in flags;

  if (foreground) {
    console.log("Starting daemon in foreground...");
    // Import and run worker directly
    await import("./worker.js");
    return;
  }

  // A stale plist survives every CLI upgrade, so check it here rather than
  // only at install time (engram#469). The Windows entry and the systemd
  // unit likewise.
  migrateLaunchdIfStale();
  repairRunEntryIfBroken();
  repairSystemdUnitIfStale();

  if (!reportStart(await startInBackground())) {
    process.exit(1);
    return;
  }
  console.log(`${dim("Log:")} ${LOG_FILE}`);
  console.log(`${dim("DB:")}  ${DB_FILE}`);

  if ("install" in flags) {
    await enableStartAtLogin(true);
  }
}

/**
 * How long before `engram start` gives up waiting on the Windows
 * supervisor's first worker the supervisor stops reporting that it couldn't
 * start (engram#613), so that a failure it reports is always seen here. It
 * starts one that fails after that again.
 */
const REPORT_MARGIN_MS = 2_000;

/**
 * Start the daemon in the background, and wait for it to be ready (see
 * waitForWorker). On Windows through the supervisor, which starts it again
 * after an error (engram#613); launchd does that on macOS.
 */
function startInBackground(): Promise<WorkerStart> {
  if (process.platform === "win32") {
    const reportUntil = Date.now() + START_WAIT_MS - REPORT_MARGIN_MS;
    return waitForWorker(spawnSupervisor(reportUntil), START_WAIT_MS, { supervisor: true });
  }
  return waitForWorker(spawnWorker());
}

/** Say how a worker just spawned got on; false when it didn't start. */
function reportStart(started: WorkerStart): boolean {
  if (started.state === "failed") {
    console.error("Daemon failed to start. Check the log:");
    console.error(`  ${process.platform === "win32" ? "type" : "cat"} "${LOG_FILE}"`);
    return false;
  }
  if (started.state === "running") {
    console.log(`${bold("Engram daemon started")} (pid ${started.pid})`);
  } else {
    // Still loading: most often the preflight rebuilding better-sqlite3 for
    // a Node it wasn't built for, which takes a minute or two.
    const pid = started.pid === null ? "" : ` (pid ${started.pid})`;
    console.log(`${bold("Engram daemon is starting")}${pid} — this one is taking a while`);
    console.log(dim("  Check on it with 'engram status' in a minute."));
  }
  return true;
}

export type WorkerStart =
  | { state: "running"; pid: number } // it answers, ready
  | { state: "starting"; pid: number | null } // alive, still loading
  | { state: "failed" }; // it exited, or never started

/**
 * Wait for a worker just spawned to answer on the daemon's socket as ready:
 * past the preflight, capture set up. A fixed half-second pause was too
 * short on Windows, where Node loads slowly the first time while antivirus
 * scans each file: `engram start` reported a failure, exited 1 and skipped
 * --install, and the daemon came up a moment later (engram#602). Gives up as
 * soon as the worker exits with an error.
 *
 * `supervisor`: `child` is the Windows supervisor (engram#613), which starts
 * the worker, so the worker's PID is the one that answers. While this
 * waits, the supervisor exits only when its first worker does: with
 * START_FAILED_EXIT when that one couldn't start, and 0 when it found
 * another daemon running. After any other error it starts the worker again.
 */
export async function waitForWorker(
  child: ChildProcess,
  timeoutMs = START_WAIT_MS,
  options: { supervisor?: boolean } = {},
): Promise<WorkerStart> {
  // In an object: TypeScript doesn't see the callbacks assign plain locals.
  const ended: { code?: number | null; error?: boolean } = {};
  child.once("exit", (code: number | null) => {
    ended.code = code;
  });
  child.once("error", () => {
    ended.error = true;
  });
  const ready = async (pid: number): Promise<number | null> => {
    if (options.supervisor) return supervisedReady();
    return (await answersReady(pid)) ? pid : null;
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(100);
    if (ended.error || child.pid === undefined) return { state: "failed" };
    if (ended.code !== undefined) return ended.code === 0 ? waitForOther(deadline) : { state: "failed" };
    const pid = await ready(child.pid);
    if (pid !== null) return { state: "running", pid };
  }
  if (ended.error || child.pid === undefined) return { state: "failed" };
  if (ended.code !== undefined) return ended.code === 0 ? waitForOther(0) : { state: "failed" };
  return { state: "starting", pid: options.supervisor ? null : child.pid };
}

/**
 * The PID of the daemon that answers, ready and not stopping: the
 * supervisor's worker, or one started beside it, which that worker then
 * leaves the capture to. Only on Windows, where the named pipe can always
 * be used.
 */
async function supervisedReady(): Promise<number | null> {
  const probe = await probeDaemon({ timeoutMs: 1_000 });
  return probe.state === "answered" && probe.info.ready && !probe.info.stopping ? probe.info.pid : null;
}

/** Whether `pid` answers on the daemon's socket, ready; where there is no socket, whether the PID file names it. */
async function answersReady(pid: number): Promise<boolean> {
  const probe = await probeDaemon({ timeoutMs: 1_000 });
  if (probe.state === "answered") return probe.info.pid === pid && probe.info.ready;
  // No socket on this machine (see daemonEndpoint): the PID file is all there is.
  return probe.state === "unavailable" && pidInFile() === pid;
}

/**
 * The worker exited 0 as soon as it started: another daemon was running, or
 * started at that moment, and it left the capture to that one (engram#612).
 * launchd starts one beside `engram start` when it loads an updated plist.
 * Waits, until `deadline`, for that daemon to be ready.
 */
async function waitForOther(deadline: number): Promise<WorkerStart> {
  for (;;) {
    const found = await findDaemon(1_000);
    if (found.state === "unresponsive") return { state: "starting", pid: found.pid };
    if (found.state !== "running") return { state: "failed" };
    if (found.ready) return { state: "running", pid: found.pid };
    if (Date.now() >= deadline) return { state: "starting", pid: found.pid };
    await sleep(100);
  }
}

async function recordCaptureIntent(v: "on" | "off"): Promise<void> {
  try {
    const config = await loadConfig();
    config.autocapture = v;
    await saveConfig(config);
  } catch {
    // config write failures never block daemon management
  }
}

/**
 * How long `engram stop` waits on Windows for the daemon to take its request
 * to stop (engram#613). The daemon looks for one every second.
 */
export const STOP_PICKUP_MS = 10_000;

/**
 * Stop the daemon: only a process confirmed to be it is signalled
 * (engram#612), and this waits for it to finish a send in progress and exit,
 * so an `engram start` straight after starts a new one.
 *
 * On Windows a signal can't be caught there: process.kill ends the process
 * wherever it is (TerminateProcess), in the middle of a send or of writing
 * its queue. So there `engram stop` asks the daemon to stop through
 * STOP_FILE, and it stops as it does for SIGTERM elsewhere (engram#613).
 * Only a daemon from before that, or one that doesn't take the request in
 * STOP_PICKUP_MS, is ended outright. Nothing queued is lost either way: what
 * it was sending is sent again when it next starts. One that holds its pipe
 * and doesn't answer is left running there: that is most often a daemon
 * rebuilding better-sqlite3, which ending it would cut off half done
 * (engram#640).
 */
export async function daemonStop(): Promise<void> {
  await recordCaptureIntent("off");
  const found = await findDaemon();
  if (found.state === "stopped") {
    // A supervisor waiting to start the daemon again after an error finds
    // this, and doesn't (engram#613).
    if (process.platform === "win32") writeStopRequest({ pid: null });
    console.log("Daemon is not running.");
    return;
  }
  if (found.pid === null) {
    console.error(red("The daemon isn't answering, and no process could be confirmed as it, so nothing was stopped."));
    console.error(dim(`  It may be busy, or still starting: try again in a minute. Its log: ${LOG_FILE}`));
    process.exitCode = 1;
    return;
  }
  const pid = found.pid;
  // One that answers as stopping is on its way out already, and is only
  // waited for.
  if (found.state !== "stopping") {
    // A named pipe's name is one namespace for the whole machine, so on
    // Windows the PID file, which only this user can write, must name the
    // process the pipe's answer gives.
    if (process.platform === "win32" && pidInFile() !== pid) {
      console.error(red(`The daemon's pipe gives pid ${pid}, and ~/.engram/daemon.pid doesn't name it, so nothing was stopped.`));
      process.exitCode = 1;
      return;
    }
    if (process.platform === "win32" && found.state === "unresponsive") {
      console.error(red(`The daemon (pid ${pid}) isn't answering right now, so it wasn't stopped.`));
      console.error(dim(`  It may be busy, or still starting: try again in a minute. Its log: ${LOG_FILE}`));
      process.exitCode = 1;
      return;
    }
    const asked =
      process.platform === "win32" && found.state === "running" && found.stopFile && found.id
        ? await askToStop(pid, found.id)
        : "unasked";
    if (asked !== "taken") {
      try {
        process.kill(pid, "SIGTERM");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") {
          removePidFileIf(pid);
          console.log("Daemon is not running.");
          return;
        }
        console.error(red(`Failed to stop daemon (pid ${pid})`));
        process.exitCode = 1;
        return;
      }
      if (asked === "ignored") {
        console.log(dim(`  It didn't take the request to stop within ${STOP_PICKUP_MS / 1000}s, so it was ended.`));
        console.log(dim("  Nothing queued is lost: what it hadn't sent goes when it next starts."));
      } else if (asked === "unwritten") {
        // Its supervisor finds no request, so it takes this for a crash.
        console.log(dim(`  Couldn't write ${STOP_FILE}, so it was ended outright, and may start again in a few seconds.`));
        console.log(dim("  If 'engram status' shows it running again, run 'engram stop' again."));
      }
    }
  }

  const gone = await exited(pid, () => console.log(dim("  Waiting for it to finish what it was sending...")));
  if (!gone) {
    console.log(`Asked the daemon to stop (pid ${pid}); it is still finishing.`);
    return;
  }
  // Its own exit removes the PID file; one killed outright can't.
  removePidFileIf(pid);
  console.log(`Daemon stopped (pid ${pid})`);
}

/**
 * Write a stop request to STOP_FILE (engram#613); false when it couldn't be
 * written. Through a temp file, so the daemon never reads half of one.
 */
function writeStopRequest(request: { pid: number | null; id?: string }): boolean {
  try {
    writePrivateFileSync(STOP_FILE, `${JSON.stringify(request)}\n`, { durable: false });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask the daemon `pid`, whose answer gave `id`, to stop, and wait up to
 * STOP_PICKUP_MS for it to take the request: it then answers as stopping,
 * or has let its pipe go. "taken": it did, or it is gone. "ignored": it
 * didn't, and is still the daemon, by its answer or by the PID file. The
 * request is left in place then, so the supervisor doesn't start it again
 * once it is ended. "unwritten": the request couldn't be written.
 */
async function askToStop(pid: number, id: string): Promise<"taken" | "ignored" | "unwritten"> {
  if (!writeStopRequest({ pid, id })) return "unwritten";
  const deadline = Date.now() + STOP_PICKUP_MS;
  for (;;) {
    await sleep(250);
    if (!alive(pid)) return "taken";
    const probe = await probeDaemon({ timeoutMs: 1_000 });
    if (probe.state === "none") return "taken";
    if (probe.state === "answered" && (probe.info.pid !== pid || probe.info.stopping)) return "taken";
    if (Date.now() >= deadline) {
      return probe.state === "answered" || pidInFile() === pid ? "ignored" : "taken";
    }
  }
}

/**
 * Print local capture stats; never let a broken native module crash status.
 *
 * Read-only: daemon.db belongs to the daemon, which may be an older version
 * than this CLI. Opening it read-write here used to bring its schema up to
 * this CLI's version under a daemon that doesn't know that schema.
 *
 * "Pending" counts what the configured key will send. What another
 * account's key queued is "held" (engram#594): it stays on this machine
 * and is sent only when that account signs in again. What was queued for a
 * conversation Engram no longer has is "not sent" (engram#593): it stays on
 * this machine, and the conversation isn't created again.
 */
async function printDbStats(): Promise<void> {
  if (!existsSync(DB_FILE)) return;
  try {
    const { DaemonDb } = await import("./db.js");
    const { keyFingerprint } = await import("./syncer.js");
    const config = await loadConfig();
    const key = process.env.ENGRAM_API_KEY || config.apiKey;
    const db = new DaemonDb(DB_FILE, { readonly: true });
    let stats: ReturnType<typeof db.getStats>;
    try {
      stats = db.getStats(key ? keyFingerprint(key) : null);
    } finally {
      db.close();
    }
    console.log(`${dim("Sessions captured:")} ${stats.sessionsMapped}`);
    console.log(`${dim("Pending sync:")}      ${plural(stats.pendingMessages, "message")}`);
    if (stats.heldMessages > 0) {
      console.log(
        `${dim("Held:")}              ${plural(stats.heldMessages, "message")} ` +
          dim(key ? "(another account's — sent when it signs in again)" : "(sent when their account signs in)"),
      );
    }
    // engram#593: Engram doesn't have their conversation any more.
    if (stats.notSentMessages > 0) {
      console.log(
        `${dim("Not sent:")}          ${plural(stats.notSentMessages, "message")} ` +
          dim("(their conversation is no longer on Engram — kept on this machine; nothing to do if you deleted it)"),
      );
    }
    console.log(`${dim("Files tracked:")}     ${stats.trackedFiles}`);
  } catch {
    console.log(dim("Local capture DB unreadable (native module mismatch?) — the daemon rebuilds it on start."));
  }
}

export async function daemonStatus(): Promise<void> {
  const found = await findDaemon();

  if (found.state === "stopped") {
    console.log(`${bold("Status:")} stopped`);

    // Still show DB stats if available
    await printDbStats();
    // A broken start-at-login entry is often why it's stopped.
    if (printAutoStart() && (await loadConfig()).autocapture !== "off") {
      // Not stopped by 'engram stop', which records autocapture "off", and
      // started at sign-in, so it stopped by itself (engram#613).
      console.log(dim("  It should be running: start at login is on. It may have stopped after an error."));
      console.log(dim(`  The end of its log says why: ${LOG_FILE}`));
      console.log(dim("  Run 'engram start' to start it again."));
    }
    return;
  }

  if (found.state === "stopping") {
    console.log(`${bold("Status:")} stopping (pid ${found.pid})`);
  } else if (found.state === "unresponsive") {
    const held = process.platform === "win32" ? "the daemon's named pipe" : "~/.engram/daemon.sock";
    console.log(
      found.pid === null
        ? `${bold("Status:")} not answering — ${held} is held, but nothing replies`
        : `${bold("Status:")} running (pid ${found.pid}) — not answering right now`,
    );
    console.log(dim("  Busy, or still starting: the first start after an update can take a minute or two."));
  } else {
    console.log(`${bold("Status:")} running (pid ${found.pid})`);
    if (!found.ready) console.log(dim("  Still starting up."));
    printVersionHint(found);
  }

  await printDbStats();

  const syncStatus = readStatus();
  printHostStatus(Boolean(syncStatus.signed_out_at));

  // Show sync health warnings
  printSyncWarnings(syncStatus);

  console.log(`${dim("Log:")} ${LOG_FILE}`);

  printAutoStart();
}

/** Print how the daemon starts at login; true when it is set to and should work. */
function printAutoStart(): boolean {
  let on = false;
  if (isLaunchdInstalled()) {
    const stale = installedPlistVersion() < PLIST_VERSION;
    console.log(
      `${dim("Auto-start:")} enabled (launchd)` +
        (stale ? red("  — outdated config, run 'engram start' to update") : ""),
    );
    on = true;
  }

  if (process.platform === "linux") return printSystemdAutoStart(readUnit());

  const entry = readRunEntry();
  if (entry === null) return on;
  if (runEntryBroken(entry)) {
    console.log(`${dim("Auto-start:")} enabled (Windows sign-in)` + red("  — broken, run 'engram start' to repair"));
  } else if (switchedOffInStartupApps()) {
    console.log(
      `${dim("Auto-start:")} off — switched off in Windows Startup apps` +
        dim("  ('engram install' turns it back on)"),
    );
  } else {
    console.log(`${dim("Auto-start:")} enabled (Windows sign-in)`);
    on = true;
  }
  return on;
}

/** printAutoStart for the systemd unit: nothing when there is none of ours. */
function printSystemdAutoStart(unit: UnitState): boolean {
  if (unit.kind !== "ours") return false;
  if (!unit.enabled) {
    console.log(
      `${dim("Auto-start:")} off — disabled with systemctl` + dim("  ('engram install' turns it back on)"),
    );
    return false;
  }
  if (unit.broken) {
    console.log(`${dim("Auto-start:")} enabled (systemd)` + red("  — broken, run 'engram start' to repair"));
    return false;
  }
  console.log(
    `${dim("Auto-start:")} enabled (systemd)` +
      (unit.version < UNIT_VERSION ? red("  — outdated config, run 'engram start' to update") : ""),
  );
  return true;
}

function printSyncWarnings(status: SyncStatus): void {
  // No key saved (engram#594): the daemon runs, but captures and sends
  // nothing until one is. Nothing queued is lost meanwhile.
  if (status.signed_out_at) {
    console.log("");
    console.log(red("  Signed out — capture is paused and nothing is sent."));
    console.log(dim("  Run 'engram auth login' to resume. Queued messages stay on this machine."));
    console.log(dim(`  Since: ${status.signed_out_at}`));
    console.log("");
    return;
  }

  // Capture comes before sending: what can't be queued here can't be sent
  // either, however healthy syncing is (engram#584).
  if (status.capture_error) {
    console.log("");
    console.log(red(`  WARNING: ${captureErrorSummary(status.capture_error)}`));
    console.log(dim(`  Since: ${status.capture_error.since}`));
    console.log("");
  }

  // Opt-outs the key in use may not delete (engram#597). Sending goes on
  // regardless, so this doesn't wait for a sync error.
  if (status.delete_refused) {
    console.log("");
    console.log(red(`  WARNING: ${deleteRefusedSummary(status.delete_refused)}`));
    console.log(dim("  Kept on this machine; not tried again with this key."));
    console.log(dim(`  Since: ${status.delete_refused.since}`));
    console.log("");
  }

  if (status.health === "healthy") {
    if (status.last_sync_at) {
      console.log(`${dim("Last sync:")}        ${status.last_sync_at}`);
    }
    return;
  }

  // The same words as the daemon's log line and desktop notification. This
  // kept a copy of its own, which had no storage_full entry: a full account
  // showed the raw server error instead of what to do about it.
  const msg = syncErrorSummary(status.error_type, status.storage);

  console.log("");
  console.log(red(`  WARNING: ${msg}`));
  if (status.pending_messages > 0) {
    console.log(red(`  ${plural(status.pending_messages, "message")} waiting to sync`));
  }
  // The latest failure: last_error_at moves with each one.
  if (status.last_error_at) {
    console.log(dim(`  Last error: ${status.last_error_at}`));
  }
  // When the daemon tries again (engram#596). A time already past means a
  // try is due at the next flush, seconds away, so it says nothing.
  const next = status.next_retry_at ? Date.parse(status.next_retry_at) : NaN;
  const wait = next - Date.now();
  if (wait > 0) {
    console.log(dim(`  Next try:   in ${formatWait(wait)} (${status.next_retry_at})`));
  }
  console.log("");
}

// ── Launchd integration ──

function generatePlist(): string {
  const nodePath = process.execPath;
  // launchd hands a job a bare PATH (/usr/bin:/bin:/usr/sbin:/sbin) — npm is
  // not on it. The ABI self-heal in preflight.ts shells out to `npm rebuild
  // better-sqlite3`, so without this it fails with command-not-found at the
  // exact moment it is needed. npm ships beside the node binary, so putting
  // node's own directory first makes the heal reachable.
  const nodeBinDir = dirname(nodePath);
  const jobPath = `${nodeBinDir}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${workerPath()}</string>
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
    <string>${homedir()}</string>
    <key>PATH</key>
    <string>${jobPath}</string>
    <key>ENGRAM_PLIST_VERSION</key>
    <string>${PLIST_VERSION}</string>
  </dict>
</dict>
</plist>`;
}

/** Version stamped into an installed plist; 1 for plists written before stamping. */
function installedPlistVersion(): number {
  try {
    const xml = readFileSync(PLIST_PATH, "utf-8");
    const m = xml.match(
      /<key>ENGRAM_PLIST_VERSION<\/key>\s*<string>(\d+)<\/string>/,
    );
    return m ? parseInt(m[1], 10) : 1;
  } catch {
    return 1;
  }
}

/**
 * launchd opens the log for the job, and creates a missing one with the
 * default 0644 (engram#627), so it is made first, 0600. Best effort: the
 * worker sets every file in ~/.engram to 0600 when it starts anyway.
 */
function prepareLaunchdLog(): void {
  try {
    prepareLogSync();
  } catch {
    // the worker's start covers it
  }
}

/**
 * Rewrite and reload a stale launchd plist (engram#469).
 *
 * Without this, a plist defect is permanent: `brew upgrade` / `npm i -g`
 * replaces the code but leaves the plist, so the machine keeps launching the
 * old entry point forever. That is how a self-heal shipped in 0.4.2 was still
 * inert on a 0.6.0 install. Runs on any daemon start; silent when current.
 */
export function migrateLaunchdIfStale(): boolean {
  if (process.platform !== "darwin") return false;
  if (!isLaunchdInstalled()) return false;
  if (installedPlistVersion() >= PLIST_VERSION) return false;

  try {
    writeFileSync(PLIST_PATH, generatePlist());
  } catch {
    return false; // not fatal — the daemon can still run in this session
  }
  prepareLaunchdLog();

  // bootout/bootstrap is the modern pair; fall back to unload/load on older
  // macOS. Either way a failure here is non-fatal: the new plist is on disk
  // and takes effect at next login.
  const uid = process.getuid?.() ?? 0;
  try {
    execSync(`launchctl bootout gui/${uid}/${PLIST_NAME}`, { stdio: "pipe" });
  } catch {
    try {
      execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: "pipe" });
    } catch {
      // already unloaded
    }
  }
  try {
    execSync(`launchctl bootstrap gui/${uid} "${PLIST_PATH}"`, { stdio: "pipe" });
  } catch {
    try {
      execSync(`launchctl load -w "${PLIST_PATH}"`, { stdio: "pipe" });
    } catch {
      // takes effect at next login
    }
  }
  console.log(
    `${bold("Updated auto-start configuration")} ${dim(`(plist v${PLIST_VERSION})`)}`,
  );
  return true;
}

function isLaunchdInstalled(): boolean {
  // Darwin only: CLIs before engram#602 wrote this plist on every platform,
  // and a stray copy must not read as "auto-start enabled" or send status
  // shelling out to launchctl on Windows.
  return process.platform === "darwin" && existsSync(PLIST_PATH);
}

function installLaunchd(): void {
  mkdirSync(PLIST_DIR, { recursive: true });
  writeFileSync(PLIST_PATH, generatePlist());
  prepareLaunchdLog();

  try {
    execSync(`launchctl load -w "${PLIST_PATH}"`, { stdio: "pipe" });
    console.log(`${bold("Auto-start enabled")} — daemon will start on login`);
    console.log(`${dim("Plist:")} ${PLIST_PATH}`);
  } catch {
    console.log(`Plist written to ${PLIST_PATH}`);
    console.log("Run manually: launchctl load -w " + PLIST_PATH);
  }
}

function uninstallLaunchd(): void {
  if (!isLaunchdInstalled()) {
    console.log("Launchd agent not installed.");
    return;
  }

  try {
    execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: "pipe" });
  } catch {
    // may already be unloaded
  }

  try {
    unlinkSync(PLIST_PATH);
  } catch {
    // ignore
  }

  console.log(`${bold("Auto-start disabled")} — launchd agent removed`);
}

// ── Windows: a per-user Run entry ──
//
// HKCU\…\Run is per-user sign-in startup: it needs no admin rights, it is
// what apps' "open at login" settings use, and Windows lists it under Startup
// apps, where it can be switched off. (A Task Scheduler logon task would work
// too, but creating one with schtasks can take admin rights.)

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE = "Engram";

// Switching an entry off under Startup apps (Settings, Task Manager) leaves
// it in the Run key and writes a value of the same name here instead: its
// first byte is 3 for off, 2 or 6 for on, and no value at all is on. The
// format is undocumented; "an odd first byte is off" is the observed rule.
// Without reading it, status said "enabled" for an entry Windows skips.
const APPROVED_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";

/**
 * reg.exe by absolute path: a bare name is looked up in the current
 * directory before PATH on Windows.
 */
function regExe(): string {
  return win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe");
}

/** The command line Windows runs at sign-in. Exported for tests. */
export function runEntryCommand(nodePath: string, entryPath: string): string {
  return `"${nodePath}" "${entryPath}"`;
}

/**
 * Node's own path, through any links. A version manager can start Node
 * through a link made for one shell session (fnm's multishell directories),
 * which may be gone by the next sign-in; the program it links to stays.
 */
function nodePathForEntry(): string {
  try {
    return realpathSync.native(process.execPath);
  } catch {
    return process.execPath;
  }
}

/**
 * Our value's data in a `reg export` of the Run key: null when it isn't
 * there, "" when it is but isn't a plain string. Exported for tests.
 *
 * The export, not `reg query`: reg prints in the console's code page, so a
 * path with a letter outside it (the "í" of "C:\Users\Ana María\…") came
 * back mangled and a working entry read as broken. The export is UTF-16.
 */
export function parseRunExport(exported: string): string | null {
  const data = exportedData(exported);
  if (data === null) return null;
  const quoted = data.match(/^"((?:[^"\\]|\\.)*)"$/);
  return quoted ? quoted[1].replace(/\\(.)/g, "$1") : "";
}

/**
 * Whether a `reg export` of the StartupApproved key has our entry switched
 * off (see APPROVED_KEY). Exported for tests.
 */
export function parseApprovedExport(exported: string): boolean {
  const first = exportedData(exported)?.match(/^hex:([0-9a-f]{2})/i);
  return !!first && parseInt(first[1], 16) % 2 === 1;
}

/** What follows `"Engram"=` in an exported key, or null when it isn't there. */
function exportedData(exported: string): string | null {
  const name = `"${RUN_VALUE.toLowerCase()}"=`;
  let inKey = false;
  for (const line of exported.split(/\r?\n/)) {
    if (line.startsWith("[")) {
      // The key's own values come first; any subkeys follow.
      if (inKey) break;
      inKey = true;
    } else if (inKey && line.toLowerCase().startsWith(name)) {
      return line.slice(name.length);
    }
  }
  return null;
}

/**
 * How long a reg.exe call may take. Auto-capture reads the Run entry after
 * interactive commands (engram#614), so a reg.exe that hung would otherwise
 * hang each of them; one that times out counts as one that failed.
 */
const REG_TIMEOUT_MS = 15_000;

function runReg(args: string[]): string {
  return execFileSync(regExe(), args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: REG_TIMEOUT_MS,
  });
}

/** A registry key as `reg export` writes it; null when reg can't (no such key). */
function exportKey(key: string): string | null {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), "engram-"));
    const file = join(dir, "key.reg");
    runReg(["export", key, file, "/y"]);
    const bytes = readFileSync(file);
    const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe;
    return bytes.toString(utf16 ? "utf16le" : "utf-8");
  } catch {
    return null;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/** The installed entry's command line; null when there is none, or off Windows. */
function readRunEntry(): string | null {
  if (process.platform !== "win32") return null;
  const exported = exportKey(RUN_KEY);
  return exported === null ? null : parseRunExport(exported);
}

/** The user switched our entry off under Startup apps. */
function switchedOffInStartupApps(): boolean {
  if (process.platform !== "win32") return false;
  const exported = exportKey(APPROVED_KEY);
  return exported !== null && parseApprovedExport(exported);
}

/**
 * Forget a Startup apps switch-off: no value there means on. For install and
 * uninstall only, which are the user asking for it on or gone; `engram
 * start` repairs a broken entry but leaves the switch where the user put it.
 */
function clearStartupSwitch(): void {
  try {
    runReg(["delete", APPROVED_KEY, "/v", RUN_VALUE, "/f"]);
  } catch {
    // never switched
  }
}

/** Either program the entry names is gone (Node moved, CLI uninstalled). */
function runEntryBroken(entry: string): boolean {
  const m = entry.match(/^"([^"]+)"\s+"([^"]+)"$/);
  return !m || !existsSync(m[1]) || !existsSync(m[2]);
}

function writeRunEntry(): boolean {
  try {
    runReg([
      "add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ",
      "/d", runEntryCommand(nodePathForEntry(), loginStartPath()), "/f",
    ]);
    return true;
  } catch {
    return false;
  }
}

function deleteRunEntry(): boolean {
  try {
    runReg(["delete", RUN_KEY, "/v", RUN_VALUE, "/f"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Point a broken entry at this CLI, the counterpart of migrateLaunchdIfStale:
 * an entry naming a Node or a CLI that has since moved fails at every
 * sign-in without a word. A working entry is left as it is.
 */
export function repairRunEntryIfBroken(entry: string | null = readRunEntry()): boolean {
  if (entry === null || !runEntryBroken(entry)) return false;
  if (!existsSync(loginStartPath()) || !writeRunEntry()) return false;
  console.log(bold("Updated the start-at-login entry"));
  return true;
}

/** The plist CLIs before engram#602 wrote off macOS too. */
function removeStrayPlist(): void {
  try {
    unlinkSync(PLIST_PATH);
  } catch {
    // none written
  }
}

// ── Linux: a systemd user unit (engram#615) ──
//
// ~/.config/systemd/user/engram.service, linked into default.target by
// `systemctl --user enable`: the user's service manager starts the daemon at
// login and again after a crash. See systemd.ts.

/** The unit for this CLI: this Node, this build's worker, this home. */
function unitForThisCli(): string {
  const node = nodePathForEntry();
  return generateUnit({
    node,
    worker: workerPath(),
    log: LOG_FILE,
    engramDir: ENGRAM_DIR,
    home: homedir(),
    path: `${dirname(node)}:/usr/local/bin:/usr/bin:/bin`,
  });
}

/**
 * Rewrite an enabled unit of ours that names a Node or a CLI that has since
 * moved, or that an older CLI wrote: the counterpart of migrateLaunchdIfStale
 * and repairRunEntryIfBroken. One the user disabled is left as it is.
 */
export function repairSystemdUnitIfStale(unit: UnitState = readUnit()): boolean {
  if (process.platform !== "linux") return false;
  if (unit.kind !== "ours" || !unit.enabled) return false;
  if (!unit.broken && unit.version >= UNIT_VERSION) return false;
  // Only a source checkout run through tsx has no worker.js: the build ships it.
  if (!existsSync(workerPath()) || !rewriteUnit(unitForThisCli())) return false;
  console.log(`${bold("Updated auto-start configuration")} ${dim(`(systemd unit v${UNIT_VERSION})`)}`);
  return true;
}

async function enableSystemdStartAtLogin(running: boolean): Promise<void> {
  removeStrayPlist();
  if (readUnit().kind === "foreign") {
    console.error(red(`Can't turn on start at login: ${unitPath()} is there already, and Engram didn't write it.`));
    console.error(dim("  Rename or remove it, then run 'engram install' again."));
    process.exitCode = 1;
    return;
  }
  const systemctl = systemctlPath();
  if (systemctl === null || !systemdReachable(systemctl)) {
    console.log(bold("Start at login isn't available here: it needs a systemd user session ('systemctl --user')."));
    console.log(dim(running ? RUNS_UNTIL_RESTART : START_AFTER_RESTART));
    return;
  }
  if (!existsSync(workerPath())) {
    // Only a source checkout run through tsx gets here: the build ships it.
    console.error(red(`Can't turn on start at login: ${workerPath()} is missing.`));
    process.exitCode = 1;
    return;
  }
  const failed = installUnit(systemctl, unitForThisCli());
  if (failed !== null) {
    console.error(red("Couldn't turn on start at login."));
    console.error(dim(`  systemctl: ${failed}`));
    process.exitCode = 1;
    return;
  }
  console.log(`${bold("Auto-start enabled")} — daemon will start when you log in (systemd)`);
  console.log(`${dim("Unit:")} ${unitPath()}`);
  // Enabled, not started: systemd starts it from the next login on. The
  // daemon now is started as 'engram start' starts it, with this shell's
  // environment, and never beside a running one.
  if (!running && !reportStart(await startInBackground())) {
    process.exitCode = 1;
  }
}

/**
 * Start at login when auto-capture turns capture on, as on macOS and
 * Windows: add the unit when there is none, and repair one of ours that is
 * broken or outdated. One the user disabled with systemctl stays disabled,
 * and one Engram didn't write is never touched. Never fails the command it
 * runs after.
 *
 * "changed": it added or repaired the unit, and said so. "failed": it
 * couldn't add one. "unavailable": there is no systemd user session to add
 * one to. autoEnableCapture says either along with the rest.
 */
function autoEnableSystemdStartAtLogin(): "changed" | "unchanged" | "failed" | "unavailable" {
  const unit = readUnit();
  if (unit.kind === "foreign") return "unchanged";
  if (unit.kind === "ours") return repairSystemdUnitIfStale(unit) ? "changed" : "unchanged";
  if (!existsSync(workerPath())) return "unchanged";
  const systemctl = systemctlPath();
  if (systemctl === null || !systemdReachable(systemctl)) return "unavailable";
  if (installUnit(systemctl, unitForThisCli()) !== null) return "failed";
  console.log(`${bold("Auto-start enabled")} — daemon will start when you log in (systemd)`);
  return "changed";
}

// ── Start at login, per platform ──

/** "Windows", "Linux", … for the messages below. */
function platformLabel(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return platform;
  }
}

const RUNS_UNTIL_RESTART =
  "  The daemon keeps running until you sign out or restart. Run 'engram start' again after that.";
const START_AFTER_RESTART = "  Run 'engram start' to capture now, and again after you sign out or restart.";

/**
 * Start at login: a launchd agent on macOS, a Run entry on Windows
 * (engram#602), a systemd user unit on Linux (engram#615). Elsewhere, this
 * used to write a macOS plist into ~/Library/LaunchAgents and run a
 * launchctl that isn't there; now it says what actually happens. `running`:
 * whether a daemon is up right now.
 */
async function enableStartAtLogin(running: boolean): Promise<void> {
  if (process.platform === "darwin") {
    installLaunchd();
    return;
  }
  if (process.platform === "win32") {
    await enableWindowsStartAtLogin(running);
    return;
  }
  if (process.platform === "linux") {
    await enableSystemdStartAtLogin(running);
    return;
  }
  console.log(bold(`Start at login isn't available on ${platformLabel()} yet.`));
  console.log(dim(running ? RUNS_UNTIL_RESTART : START_AFTER_RESTART));
}

async function enableWindowsStartAtLogin(running: boolean): Promise<void> {
  removeStrayPlist();
  const entryPath = loginStartPath();
  if (!existsSync(entryPath)) {
    // Only a source checkout run through tsx gets here: the build ships it.
    console.error(red(`Can't turn on start at login: ${entryPath} is missing.`));
    return;
  }
  if (!writeRunEntry()) {
    console.error(red("Couldn't add the Windows startup entry."));
    console.error(dim(`  It goes in ${RUN_KEY} as "${RUN_VALUE}". Run 'engram install' to try again.`));
    return;
  }
  clearStartupSwitch();
  console.log(`${bold("Auto-start enabled")} — daemon will start when you sign in to Windows`);
  console.log(dim("  A console window flashes briefly at sign-in while it starts."));
  console.log(`${dim("Startup entry:")} ${RUN_KEY}\\${RUN_VALUE}`);
  // launchctl load starts the agent right away on macOS; match that, but
  // never start a second worker beside a running one. Through the
  // supervisor, as at sign-in, so it is started again after an error too.
  if (!running && !reportStart(await startInBackground())) {
    process.exitCode = 1;
  }
}

/**
 * Start at login when auto-capture turns capture on (engram#614), the
 * Windows counterpart of the launchd agent it installs on macOS: add the
 * entry when there is none, and point a broken one at this CLI. Unlike
 * `engram install`, it leaves the Startup apps switch where the user put it,
 * as macOS leaves a login item switched off under Login Items, and it never
 * fails the command it runs after.
 *
 * "changed": it added or repaired the entry, and said so. "failed": it
 * couldn't add one, which autoEnableCapture says along with the rest.
 */
function autoEnableWindowsStartAtLogin(): "changed" | "unchanged" | "failed" {
  const entry = readRunEntry();
  if (entry !== null) return repairRunEntryIfBroken(entry) ? "changed" : "unchanged";
  // Only a source checkout run through tsx has no login-start.js: the build ships it.
  if (!existsSync(loginStartPath())) return "unchanged";
  if (!writeRunEntry()) return "failed";
  if (switchedOffInStartupApps()) {
    console.log(`${bold("Start at login is switched off")} in Windows Startup apps`);
    console.log(dim("  Switch Engram on there, or run 'engram install', to start the daemon when you sign in."));
    return "changed";
  }
  console.log(`${bold("Auto-start enabled")} — daemon will start when you sign in to Windows`);
  console.log(dim("  A console window flashes briefly at sign-in while it starts."));
  return "changed";
}

async function disableStartAtLogin(): Promise<void> {
  if (process.platform === "darwin") {
    uninstallLaunchd();
    return;
  }
  removeStrayPlist();
  if (process.platform === "win32") {
    if (readRunEntry() === null) {
      console.log("Auto-start isn't on.");
    } else if (deleteRunEntry()) {
      clearStartupSwitch();
      console.log(`${bold("Auto-start disabled")} — the Windows startup entry is removed`);
    } else {
      console.error(red("Couldn't remove the Windows startup entry."));
      console.error(dim(`  Remove "${RUN_VALUE}" from ${RUN_KEY}, or switch it off under Startup apps.`));
      return;
    }
    if ((await findDaemon()).state !== "stopped") {
      console.log(dim("  The daemon keeps running until 'engram stop' or sign-out."));
    }
    return;
  }
  if (process.platform === "linux") {
    const unit = readUnit();
    if (unit.kind === "none") {
      console.log("Auto-start isn't on.");
    } else if (unit.kind === "foreign") {
      console.log("Auto-start isn't on.");
      console.log(dim(`  ${unitPath()} isn't one Engram wrote, so it was left as it is.`));
    } else {
      try {
        removeUnit();
      } catch {
        console.error(red("Couldn't remove the systemd unit."));
        console.error(dim(`  Remove ${unitPath()} to turn start at login off.`));
        process.exitCode = 1;
        return;
      }
      console.log(`${bold("Auto-start disabled")} — the systemd unit is removed`);
    }
    if ((await findDaemon()).state !== "stopped") {
      console.log(dim("  The daemon keeps running until 'engram stop' or sign-out."));
    }
    return;
  }
  console.log(`Start at login isn't set up on ${platformLabel()}, so there is nothing to remove.`);
}

export async function daemonInstall(): Promise<void> {
  await recordCaptureIntent("on");
  // A daemon that is stopping isn't counted: on Windows a new worker is
  // started, which takes over once that one has gone.
  const found = await findDaemon();
  await enableStartAtLogin(found.state === "running" || found.state === "unresponsive");
}

/**
 * Auto-capture is the product default: a successful interactive login
 * turns the capture daemon on and enables start-at-login, loudly, with a
 * one-line off switch. Never fatal — login must succeed even if the
 * daemon can't start. Skipped for scripted logins (no TTY) and when
 * ENGRAM_NO_AUTOCAPTURE is set.
 *
 * After any other command it makes sure capture is still on, and says so
 * only when it had to do something: start the daemon, or turn on or repair
 * start at login (engram#644). A reminder after every search pushes the
 * command's own output up, and teaches people to skip what follows a
 * command, which is where a real warning would be.
 */
export async function autoEnableCapture({ after }: { after: "login" | "command" }): Promise<void> {
  if (process.env.ENGRAM_NO_AUTOCAPTURE) return;
  if (!process.stdin.isTTY) return;
  const platform = process.platform;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") return;
  try {
    const config = await loadConfig();
    if (config.autocapture === "off") return; // user said stop; respect it
    if (!(process.env.ENGRAM_API_KEY ?? config.apiKey)) return; // nothing to capture into
    let changed = false;
    const found = await findDaemon(500);
    if (found.state === "stopped" || found.state === "stopping") {
      // On Windows through the supervisor, as at sign-in, so a worker that
      // exits with an error is started again (engram#613). Nothing waits on
      // it here, so it is never asked to report a failed start.
      if (platform === "win32") spawnSupervisor();
      else spawnWorker();
      changed = true;
      await sleep(500);
    }
    let startAtLoginFailed = false;
    let startAtLoginUnavailable = false;
    if (platform === "darwin" && !isLaunchdInstalled()) {
      installLaunchd();
      changed = true;
    } else if (platform === "win32" || platform === "linux") {
      const startAtLogin = platform === "win32" ? autoEnableWindowsStartAtLogin() : autoEnableSystemdStartAtLogin();
      if (startAtLogin === "changed") changed = true;
      startAtLoginFailed = startAtLogin === "failed";
      startAtLoginUnavailable = startAtLogin === "unavailable";
    } else if (migrateLaunchdIfStale()) {
      changed = true;
    }
    if (after === "command" && !changed) return;
    // Said with the rest, not after every command while it keeps failing:
    // after a command, that is when the daemon had to be started, which is
    // what start at login would have done.
    if (startAtLoginFailed) {
      console.log(dim("  Couldn't turn on start at login. Run 'engram install' to try again."));
    }
    console.log(
      `${bold("Auto-capture is on")} — conversations from supported agents on this machine save to your Engram.`,
    );
    if (startAtLoginUnavailable) {
      console.log(
        dim("  Start at login isn't available here (no systemd user session): run 'engram start' after a restart."),
      );
    }
    console.log(dim("  Turn off anytime: engram stop && engram uninstall"));
  } catch {
    // Non-fatal by design: capture is a convenience, login is the job.
  }
}

export async function daemonUninstall(): Promise<void> {
  await recordCaptureIntent("off");
  await disableStartAtLogin();
}
