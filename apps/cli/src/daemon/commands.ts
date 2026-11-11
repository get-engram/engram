import { execFileSync, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { bold, dim, plural, red } from "../output.js";
import { loadConfigStrict, saveConfig, saveFailure, type Config } from "../config.js";
import { ConfigUnreadable } from "../config-file.js";
import { inspectConfig, lockedConfigDir, printEmptyConfigNote } from "../config-guard.js";
import { writePrivateFileSync } from "../private-files.js";
import {
  readStatus,
  syncErrorSummary,
  captureErrorSummary,
  configProblemSummary,
  deleteRefusedSummary,
  type SyncStatus,
} from "./status.js";
import { formatWait } from "./backoff.js";
import { ALL_ADAPTERS } from "./adapters.js";
import { asRootRefusal, rootForAnotherUser } from "./as-root.js";
import { commandFailure } from "./command-path.js";
import { throughOptLink } from "./homebrew.js";
import { INSTALL_CLI, runnerCacheOf } from "./package-runner.js";
import {
  foreignFiles,
  foreignFilesFix,
  foreignFilesProblem,
  lockedDir,
  lockedDirFix,
  lockedDirProblem,
  lockedDirReason,
  OWNERSHIP_FIX,
  type ForeignFiles,
  type LockedDir,
} from "./ownership.js";
import { envVaultKeySaved, envVaultKeyState, vaultKeyFileState, vaultKeyFix, VaultKeyUnreadable } from "../vault-key.js";
import {
  ENGRAM_DIR,
  LOG_FILE,
  START_WAIT_MS,
  logProblem,
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
  type DaemonOutput,
  type Probe,
} from "./instance.js";
import {
  UNIT_VERSION,
  generateUnit,
  installUnit,
  readUnit,
  removeUnit,
  rewriteUnit,
  startUnit,
  systemctlPath,
  systemdReachable,
  unitPath,
  unitPid,
  type UnitState,
} from "./systemd.js";
import {
  findRootDaemon,
  rootDaemonLines,
  systemJobLeft,
  untiedRootLine,
  untiedRootWorkers,
  type RootDaemon,
} from "./root-daemon.js";
import {
  LAUNCH_AGENTS_FIX,
  PLIST_VERSION,
  agentDisabled,
  agentLoaded,
  agentPid,
  enableAgent,
  generatePlist,
  kickstartAgent,
  launchAgentsNotYours,
  loadAgent,
  plistPath,
  readPlist,
  reloadAgent,
  systemJob,
  unloadAgent,
  writePlistFile,
  type PlistState,
} from "./launchd.js";

/** Render the per-host capture status (engram#261). `paused`: why nothing
 *  is captured, e.g. the daemon runs without a key (engram#594). */
function printHostStatus(paused?: string): void {
  console.log(`${dim("Hosts:")}`);
  for (const a of ALL_ADAPTERS) {
    const on = a.available();
    const mark = on ? "✓" : "·";
    const state = on ? (paused ? `paused (${paused})` : "capturing") : "not installed";
    console.log(`  ${mark} ${a.label.padEnd(14)} ${dim(state)}`);
  }
}

const DB_FILE = join(ENGRAM_DIR, "daemon.db");

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
      /** From its answer: where its output goes (engram#720). */
      output?: DaemonOutput;
    }
  /** It answers, and is shutting down: finishing a send, then exiting. */
  | { state: "stopping"; pid: number }
  /**
   * Something holds the socket and doesn't answer: most often a daemon
   * whose preflight is rebuilding better-sqlite3, which keeps it busy for a
   * minute or two. `pid`: when launchd or the PID file names the daemon.
   */
  | { state: "unresponsive"; pid: number | null }
  /**
   * Nothing of the user's runs, and a daemon runs as root for them
   * (engram#680): `sudo engram start` or `sudo engram install` started it
   * before engram#653. They can't stop it with `engram stop`, and no
   * daemon of theirs starts while it runs.
   */
  | ({ state: "root" } & RootDaemon)
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
    output: info.output,
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
    return { state: "unresponsive", pid: readLaunchdPid() ?? usersOwn(pidFileDaemon(false)) };
  }
  // Nothing answers. A daemon from before engram#612 has no socket, but
  // launchd, or its PID file confirmed, still finds it. (A daemon since
  // listens before it writes the PID file.) Where no socket can be used
  // (probe "unavailable"), that is how every daemon is found.
  const launchd = readLaunchdPid();
  const inFile = launchd === null ? pidFileDaemon(true) : null;
  const pid = launchd ?? usersOwn(inFile);
  if (pid !== null) return { state: "running", pid, ready: true, older: probe.state === "none" };
  // One running as root for them (engram#680), named in the PID file or run
  // by a job in launchd's system domain. Its socket, if it has one, is
  // root's: the probe can't use it.
  const root = findRootDaemon(inFile);
  return root === null ? { state: "stopped" } : { state: "root", ...root };
}

/**
 * The daemon the PID file names, when that process is confirmed to be it
 * (see identifyProcess). `root`: it runs as root for this user (engram#680);
 * its file is kept, as it is still running. `tidy`: remove a file that
 * names a process that has exited, or another program.
 */
function pidFileDaemon(tidy: boolean): { pid: number; root: boolean } | null {
  const pid = pidInFile();
  if (pid === null || pid === process.pid) return null;
  if (!alive(pid)) {
    if (tidy) removePidFileIf(pid);
    return null;
  }
  const what = identifyProcess(pid);
  if (what === "other" && tidy) removePidFileIf(pid);
  return what === "daemon" || what === "root" ? { pid, root: what === "root" } : null;
}

/** Its PID, when it runs as the user. */
function usersOwn(found: { pid: number; root: boolean } | null): number | null {
  return found !== null && !found.root ? found.pid : null;
}

/** "Daemon already running", for a start that finds one. */
function printAlreadyRunning(found: Extract<DaemonFound, { state: "running" | "unresponsive" }>): void {
  const pid = found.pid === null ? "" : ` (pid ${found.pid})`;
  if (found.state === "unresponsive") {
    console.log(`Daemon already running${pid}, but it isn't answering right now`);
    console.log(dim(`  It may be busy, or still starting.${itsLog()}`));
    return;
  }
  console.log(`Daemon already running${pid}`);
  printVersionHint(found);
  // Its log can be written, and it doesn't write there (engram#720): a
  // start after fixing the log finds it running.
  if (found.output !== undefined && found.output !== "log" && logProblem() === null) {
    printLog(true, found.pid, undefined, found.output);
  }
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
  return isLaunchdInstalled() ? agentPid() : null;
}

/**
 * `sudo engram start` or `sudo engram install` would set capture up for
 * root, not for the user (engram#653), and `sudo engram stop` or
 * `uninstall` would save the setting as root's (engram#682): say so, and
 * change nothing. The CLI's entry refuses them first; this is for any
 * other caller.
 */
function refusedAsRoot(command: "start" | "stop" | "install" | "uninstall"): boolean {
  if (!rootForAnotherUser()) return false;
  const { problem, fix } = asRootRefusal(command);
  console.error(red(problem));
  console.error(dim(fix));
  process.exitCode = 1;
  return true;
}

/**
 * Where this CLI runs from, as a message names it ("npx's cache"), when a
 * package runner installed it there (engram#665); null when it is
 * installed. Told by the path start at login would name: the worker, and on
 * Windows the sign-in entry beside it.
 */
function runnerCacheOfThisCli(): string | null {
  return runnerCacheOf(process.platform === "win32" ? loginStartPath() : workerPath());
}

/**
 * Say that start at login can't be turned on or repaired from this CLI,
 * which runs from a package runner's cache (`where`, engram#665), and how
 * to install the CLI. `again`: the command to run then.
 */
function printRunnerRefusal(where: string, what: "turn on" | "repair", again: string): void {
  console.error(red(`Can't ${what} start at login: this Engram runs from ${where}, which can be cleared at any time.`));
  console.error(dim(`  Install the CLI with: ${INSTALL_CLI}`));
  console.error(dim(`  Then run: ${again}`));
}

/**
 * `engram install` and `engram start --install` from a CLI that a package
 * runner runs from its cache (engram#665): start at login would name the
 * files there, and once the cache was cleared the daemon no longer started
 * at login, without a word. Say so, and how to install the CLI, and change
 * nothing: no start now either, as the command asked for both.
 */
function refusedFromRunnerCache(again: "engram install" | "engram start --install"): boolean {
  const where = runnerCacheOfThisCli();
  if (where === null) return false;
  printRunnerRefusal(where, "turn on", again);
  process.exitCode = 1;
  return true;
}

export async function daemonStart(
  _args: string[],
  flags: Record<string, string>,
): Promise<void> {
  if (refusedAsRoot("start")) return;
  if ("install" in flags && refusedFromRunnerCache("engram start --install")) return;
  await recordCaptureIntent("on", "start");
  // `engram stop` and then `engram start`: the last daemon may still be
  // finishing a send. A worker started now would only wait for it too.
  const found = await whileStopping(await findDaemon());
  if (found.state === "stopping") {
    console.error(red(`The daemon is still stopping (pid ${found.pid}). Run 'engram start' again in a moment.`));
    process.exitCode = 1;
    return;
  }
  // Files in ~/.engram that are another user's (engram#659), and a
  // ~/.engram whose own permissions keep the user out of it (engram#723).
  const foreign = foreignFiles();
  const locked = lockedDir();
  const again = "install" in flags ? "engram start --install" : "engram start";
  if (found.state === "root") {
    // A daemon started beside it would exit at once (engram#680), and with
    // --install, so would the one start at login starts.
    printRootDaemon(found, "No daemon of yours starts while it runs.", { foreign, again });
    process.exitCode = 1;
    return;
  }
  if (found.state === "running" || found.state === "unresponsive") {
    printAlreadyRunning(found);
    // It runs, so they haven't stopped it: only said.
    if (foreign) printForeignFiles(foreign, "running");
    if (locked) {
      // It goes on with what it opened as it started (engram#723). Start at
      // login isn't turned on: the daemon launchd or systemd would start,
      // now and at each login, would stop at once.
      const install = "install" in flags;
      printLockedDir(locked, "running", install ? again : undefined);
      // One that can't open the files in its folder captures nothing now.
      if (install || locked.search) process.exitCode = 1;
      if (install) return;
    }
    // --install still asks for start at login (engram#602). On macOS,
    // loading the launchd agent starts a worker there and then, which finds
    // this daemon and exits (engram#612).
    if ("install" in flags) await enableStartAtLogin(true, "engram start --install");
    printOutsideManager(found);
    return;
  }

  if (foreign || locked) {
    // A daemon started now would stop at once: none is started. Not in the
    // foreground either: the fix is the same, and takes a moment. A log
    // that is another user's only costs the log (engram#679). One in a
    // ~/.engram that keeps them out would stop too (engram#723): said
    // last, with the command to run again once both are fixed.
    const stops = stopsCapture(foreign) || locked !== null;
    if (foreign) printForeignFiles(foreign, "stopped", stops && !locked ? "start" : undefined);
    if (locked) printLockedDir(locked, "stopped", again);
    if (stops) {
      process.exitCode = 1;
      return;
    }
  }

  // A daemon running as root that nothing ties to this user (engram#680):
  // said, as theirs would run beside it.
  printUntiedRootWorkers([], foreign);

  const foreground = "foreground" in flags || "f" in flags;

  if (foreground) {
    console.log("Starting daemon in foreground...");
    // Import and run worker directly
    await import("./worker.js");
    return;
  }

  // A stale plist survives every CLI upgrade, so check it here rather than
  // only at install time (engram#469), and a broken one too (engram#616).
  // The Windows entry and the systemd unit likewise. With --install, start
  // at login is turned on below, which says what stops it (engram#715).
  // From a package runner's cache, a broken one stays broken: said, as the
  // daemon then starts only when they start it (engram#665).
  const repairs = [
    repairLaunchdIfStale(undefined, { quiet: "install" in flags }),
    repairRunEntryIfStale(),
    repairSystemdUnitIfStale(),
  ];
  const runner = repairs.includes("runner") ? runnerCacheOfThisCli() : null;
  if (runner !== null) printRunnerRefusal(runner, "repair", "engram install");

  // Start at login first where the service manager starts the daemon then:
  // on macOS, loading the agent has launchd start it (engram#641); on Linux,
  // with the unit enabled, systemd is asked to (engram#689). Then it is
  // theirs, and they start it again after a crash. Not with settings in this
  // environment that their daemon wouldn't have: the daemon is started here
  // then, as before. Nor without a systemd user session: that start at login
  // isn't available is said after the start, as before.
  const platform = process.platform;
  const managerFirst =
    "install" in flags && !daemonEnvOverrides() && (platform === "darwin" || (platform === "linux" && systemdSession()));
  if (managerFirst && platform === "darwin") await enableLaunchdStartAtLogin(false, "engram start --install");
  if (managerFirst && platform === "linux") await enableSystemdStartAtLogin(true, false);

  const started = await startInBackground();
  if (!reportStart(started)) {
    process.exit(1);
    return;
  }
  printLog(true, started.state === "failed" ? null : started.pid);
  console.log(`${dim("DB:")}  ${DB_FILE}`);

  if ("install" in flags && !managerFirst) {
    await enableStartAtLogin(true, "engram start --install");
  }
}

/**
 * Said when the daemon runs, and launchd or systemd isn't running it though
 * it could (engram#641, engram#689): it doesn't start that one again after
 * a crash. A daemon `engram start` spawned before this version, or with a
 * key, a server or the vault key set that their daemon wouldn't have, or
 * one theirs found running as it started. A stop and a start hand it to
 * them. Not when the version hint says to do that anyway. `engram start`
 * and `engram install` say it when they find the daemon running, and
 * `engram status` under its Auto-start line (engram#692).
 *
 * `switchedOn`: the caller asked launchctl already, and launchd hasn't the
 * job switched off.
 */
function printOutsideManager(found: DaemonFound, switchedOn = false): void {
  if (found.state !== "running" || found.older) return;
  if (found.version && VERSION !== "unknown" && found.version !== VERSION) return;
  const manager = outsideLaunchd(found.pid, switchedOn) ? "launchd" : outsideSystemd(found.pid) ? "systemd" : null;
  if (manager === null) return;
  console.log(
    dim(
      `  The running daemon (pid ${found.pid}) wasn't started by ${manager}, so ${manager} won't restart it after a crash: run 'engram stop' and then 'engram start' to fix that.`,
    ),
  );
}

/** launchd could run this CLI's daemon, and doesn't run `pid`. */
function outsideLaunchd(pid: number, switchedOn: boolean): boolean {
  if (!launchdRunsThisCli()) return false;
  const agent = agentPid();
  if (agent === pid) return false;
  if (agent === null && !agentLoaded()) return false;
  return switchedOn || agentDisabled() !== true;
}

/**
 * systemd could run this CLI's daemon, and doesn't run `pid`: the unit's
 * MainPID is another, or 0 when it runs none. Not when no service manager
 * answers, which could start it.
 */
function outsideSystemd(pid: number): boolean {
  const unit = systemdMainPid();
  return unit !== null && unit !== pid;
}

/**
 * The PID of the daemon Engram's unit runs, 0 when it runs none, or null
 * when systemd couldn't run this CLI's daemon, or doesn't answer.
 */
function systemdMainPid(): number | null {
  if (!systemdRunsThisCli()) return null;
  const file = systemctlPath();
  return file === null ? null : unitPid(file, "MainPID");
}

/**
 * Say what in ~/.engram is another user's, and how to make it the user's
 * (engram#659). `daemon`: whether it runs. `again`: the command they
 * stopped, to run again then. `engram start` and `engram install` say it
 * themselves: the banner before a command isn't shown for them.
 */
function printForeignFiles(foreign: ForeignFiles, daemon: "running" | "stopped", again?: "start" | "install"): void {
  console.error(red(foreignFilesProblem(foreign, daemon)));
  console.error(dim(`  ${foreignFilesFix(foreign)}`));
  if (again) console.error(dim(`  Then run 'engram ${again}' again.`));
}

/**
 * Say that ~/.engram's own permissions keep the user out of it, what that
 * stops, and what fixes it (engram#723). `daemon`: whether it runs.
 * `again`: the command that did nothing because of it, to run again then.
 * `engram start` and `engram install` say it themselves, as for
 * printForeignFiles.
 */
function printLockedDir(locked: LockedDir, daemon: "running" | "stopped", again?: string): void {
  console.error(red(lockedDirProblem(locked, daemon)));
  console.error(dim(`  ${lockedDirFix(locked)}`));
  if (again) console.error(dim(`  Then run '${again}' again.`));
}

/** Whether they stop the daemon. */
function stopsCapture(foreign: ForeignFiles | null): boolean {
  return foreign !== null && foreign.stopsDaemon;
}

/**
 * Why a running daemon doesn't write to its log, by where its output goes
 * (engram#720).
 */
const NOT_THE_LOG: Record<Exclude<DaemonOutput, "log">, string> = {
  none: "it started without it",
  deleted: "the log it writes to has been deleted or replaced",
  file: "it writes to another file",
  terminal: "it writes to the terminal it was started in",
};

const IN_JOURNAL = "  systemd keeps its output in the journal: journalctl --user -u engram";

/**
 * The Log line of `engram start` and `engram status`: where the daemon's
 * log is, or that it can't be written, so the daemon runs without it
 * (engram#679), and what fixes that. `running`: whether a daemon runs,
 * and `pid`, its PID where that is known: systemd keeps what one it
 * started writes in the journal. `said`: a fix said above it, for
 * ~/.engram (engram#723), which isn't said again. `output`: where the
 * running daemon's output goes, when it says (engram#720), given only for
 * one that runs. One that runs keeps the output it was started with,
 * whatever is done to the log since, until it is started again.
 */
function printLog(running: boolean, pid: number | null = null, said?: string, output?: DaemonOutput): void {
  const problem = logProblem();
  // Asked only when it would be said: it runs systemctl.
  const journal = (): boolean => pid !== null && systemdMainPid() === pid;
  if (problem === null) {
    if (output === undefined || output === "log") {
      console.log(`${dim("Log:")} ${LOG_FILE}`);
      return;
    }
    console.log(`${dim("Log:")} ${LOG_FILE}, but the daemon doesn't write to it: ${NOT_THE_LOG[output]}.`);
    if (output === "none" && journal()) console.log(dim(IN_JOURNAL));
    // Not one in the foreground, which was started to write there.
    if (output !== "terminal") console.log(dim("  'engram stop' and then 'engram start' have the daemon write to it."));
    return;
  }
  const fix = logFix(problem);
  const fixLine = fix !== null && fix !== said ? dim(`  To fix it, run: ${fix}`) : null;
  if (output === "log") {
    // It opened the log as it started, and goes on writing to it. Started
    // again before the log is fixed, it would run without it: no stop and
    // start is suggested.
    console.log(
      `${dim("Log:")} ${LOG_FILE}. The daemon writes to it, but it can't be opened for writing now (${problem}), so a daemon started again would run without it.`,
    );
    if (fixLine) console.log(fixLine);
    return;
  }
  console.log(
    `${dim("Log:")} ${LOG_FILE} can't be written (${problem}), so the daemon ${running ? "runs" : "will run"} without it.`,
  );
  if ((output === undefined || output === "none") && journal()) console.log(dim(IN_JOURNAL));
  if (fixLine) console.log(fixLine);
  if (running && output !== "terminal") {
    console.log(dim("  Once it can be written, 'engram stop' and then 'engram start' have the daemon write to it again."));
  }
}

/** " Its log: …", after a sentence; nothing while it can't be written (engram#679). */
function itsLog(): string {
  return logProblem() === null ? ` Its log: ${LOG_FILE}` : "";
}

/**
 * `chmod u+w` for the log, or for ~/.engram when the log isn't there, when
 * the user's own lacks its write permission and that is all that's wrong.
 * Null otherwise: another user's is said with the rest that is theirs
 * (engram#659), with its chown.
 */
function logFix(problem: string): string | null {
  if (problem !== "EACCES" || process.platform === "win32") return null;
  for (const [path, shown] of [
    [LOG_FILE, "~/.engram/daemon.log"],
    [ENGRAM_DIR, "~/.engram"],
  ]) {
    let st;
    try {
      st = statSync(path);
    } catch {
      continue; // not there: the folder it is made in is what matters
    }
    if (st.uid !== process.geteuid?.()) return null;
    return (st.mode & 0o200) === 0 ? `chmod u+w ${shown}` : null;
  }
  return null;
}

/**
 * engram#680, for `engram start`, `stop` and `install`, which do nothing
 * while a daemon runs as root for the user. `why`: what that means for the
 * command. Then what stops it, and what makes capture theirs again: the
 * files it made (`foreign`), made theirs, and `again`, the command to run
 * again, if any.
 */
function printRootDaemon(
  root: RootDaemon,
  why: string,
  { foreign, again }: { foreign: ForeignFiles | null; again?: string },
): void {
  const { problem, fixes } = rootDaemonLines(root);
  console.error(red(`${problem} ${why}`));
  for (const fix of fixes) console.error(dim(`  ${fix}`));
  if (foreign) {
    console.error(red(foreignFilesProblem(foreign)));
    console.error(dim(`  ${foreignFilesFix(foreign, true)}`));
  }
  if (again) console.error(dim(`  Then run '${again}' again.`));
}

/**
 * Daemons running as root that nothing ties to this user, besides `known`
 * (engram#680): only said. Most likely theirs, from `sudo engram start`
 * with a CLI that then removed its PID file, but that can't be told.
 */
function printUntiedRootWorkers(known: (number | null)[], foreign: ForeignFiles | null): void {
  const untied = untiedRootWorkers(known, foreign);
  if (untied.length > 0) console.error(red(untiedRootLine(untied)));
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
 * after an error (engram#613). On macOS through launchd, which does that
 * too, when its agent is loaded (engram#641), and on Linux through systemd,
 * when its unit is enabled (engram#689).
 */
function startInBackground(): Promise<WorkerStart> {
  if (process.platform === "win32") {
    const reportUntil = Date.now() + START_WAIT_MS - REPORT_MARGIN_MS;
    return waitForWorker(spawnSupervisor(reportUntil), START_WAIT_MS, { supervisor: true });
  }
  const manager = serviceManager();
  if (manager) return startThroughManager(manager);
  return waitForWorker(spawnWorker());
}

/**
 * Settings in this command's environment that a daemon spawned from it
 * inherits, and one the service manager starts doesn't have: launchd gives
 * its job only the plist's environment (engram#641), and systemd its unit
 * only the unit's and its own (engram#689). A key or a server set here, or
 * the vault key, which the daemon scrubs vault values with, unless
 * ~/.engram/vault-key holds it, which their daemon reads (engram#690). With
 * one of them set, the daemon is spawned, as before.
 */
function daemonEnvOverrides(): boolean {
  return Boolean(
    process.env.ENGRAM_API_KEY ||
      process.env.ENGRAM_BASE_URL?.trim() ||
      (process.env.ENGRAM_VAULT_KEY && !envVaultKeySaved()),
  );
}

/**
 * The agent is ours and current, for this CLI (plistForThisCli), and the
 * daemon launchd starts from it has everything this command's environment
 * would give one (daemonEnvOverrides). No launchctl call.
 */
function launchdRunsThisCli(): boolean {
  if (process.platform !== "darwin" || daemonEnvOverrides() || !isLaunchdInstalled()) return false;
  const made = plistForThisCli();
  return "text" in made && installedPlistText() === made.text;
}

/**
 * launchd can start this CLI's daemon (engram#641): launchdRunsThisCli,
 * and the agent is loaded and not switched off. A plist of another CLI's,
 * or one not loaded, is left as it is, and the daemon is spawned.
 */
function launchdCanStart(): boolean {
  return launchdRunsThisCli() && agentLoaded() && agentDisabled() !== true;
}

/** A service manager that can start the daemon, and starts it again after a crash. */
interface ServiceManager {
  name: "launchd" | "systemd";
  /** The command it is asked through, named with what it says when it refuses. */
  tool: "launchctl" | "systemctl";
  /** Ask it to start the daemon: null when it took that, else what it said. */
  start: () => string | null;
  /** The PID of the daemon it started; null while there is none to name. */
  pid: () => number | null;
}

/**
 * The service manager that can start this CLI's daemon now: launchd, when
 * its agent is loaded and not switched off (launchdCanStart, engram#641), or
 * systemd, when its unit is ours, enabled and current, and the user's
 * service manager answers (engram#689). Null when neither can: the daemon is
 * spawned then, as before, and nothing more is said.
 */
function serviceManager(): ServiceManager | null {
  if (launchdCanStart()) return { name: "launchd", tool: "launchctl", start: kickstartAgent, pid: agentPid };
  if (!systemdRunsThisCli()) return null;
  const file = systemctlPath();
  if (file === null || !systemdReachable(file)) return null;
  return {
    name: "systemd",
    tool: "systemctl",
    start: () => startUnit(file),
    // The last process systemd started for the unit, which it names until
    // the next: one that exits as it starts is still seen to have started.
    // 0 before it has started any.
    pid: () => unitPid(file, "ExecMainPID") || null,
  };
}

/**
 * Have the service manager start the daemon, and wait for it to be ready
 * (engram#641, engram#689). It starts the daemon it runs again after a
 * crash; one spawned, it doesn't. The daemon is spawned, as before, when it
 * won't start it, or hasn't within MANAGER_SPAWN_WAIT_MS: said, since that
 * one isn't restarted.
 */
async function startThroughManager(manager: ServiceManager): Promise<WorkerStart> {
  const refused = manager.start();
  if (refused === null) {
    const started = await waitForAgent(START_WAIT_MS, MANAGER_SPAWN_WAIT_MS, manager.pid);
    if (started !== null) return started;
  }
  const why =
    refused === null ? "didn't start the daemon in time" : `couldn't start the daemon (${manager.tool}: ${refused})`;
  console.log(dim(`  ${manager.name} ${why}, so it is started directly, and won't be restarted after a crash.`));
  return waitForWorker(spawnWorker());
}

/**
 * How long `engram start` waits for launchd or systemd to start the daemon
 * it asked for before spawning one itself. They start it at once, as a rule.
 */
const MANAGER_SPAWN_WAIT_MS = 3_000;

/**
 * Wait for the daemon the service manager was asked to start (kickstartAgent,
 * startUnit) to answer on its socket as ready, as waitForWorker waits for
 * one spawned. Its PID is the service manager's (`pidOf`: agentPid by
 * default), asked for at once: launchd names the process as it starts it,
 * and systemd keeps naming the last one it started, so one that exits as it
 * starts is still seen to have started. Gives up as soon as that process
 * has exited with nothing holding the socket: it couldn't start. A daemon
 * that answers, ready, is the one running: the service manager's, or one
 * started beside it, which the service manager's leaves the capture to
 * (engram#612).
 *
 * Null when the service manager hasn't started a process within
 * `spawnWaitMs`: the caller spawns the daemon then. Exported for tests.
 */
export async function waitForAgent(
  timeoutMs = START_WAIT_MS,
  spawnWaitMs = MANAGER_SPAWN_WAIT_MS,
  pidOf: () => number | null = agentPid,
): Promise<WorkerStart | null> {
  const start = Date.now();
  const deadline = start + timeoutMs;
  let pid = pidOf();
  while (Date.now() < deadline) {
    await sleep(100);
    const probe = await probeDaemon({ timeoutMs: 1_000 });
    if (probe.state === "answered" && probe.info.ready && !probe.info.stopping) {
      return { state: "running", pid: probe.info.pid };
    }
    pid ??= pidOf();
    // A daemon holds the socket, and is still loading.
    if (probe.state === "answered" || probe.state === "silent") continue;
    if (pid === null) {
      if (Date.now() - start >= spawnWaitMs) return null;
      continue;
    }
    // No socket on this machine (see daemonEndpoint): the PID file is all there is.
    if (probe.state === "unavailable" && pidInFile() === pid) return { state: "running", pid };
    if (!alive(pid)) return { state: "failed" };
  }
  return { state: "starting", pid };
}

/** Say how a worker just spawned got on; false when it didn't start. */
function reportStart(started: WorkerStart): boolean {
  if (started.state === "failed") {
    const problem = logProblem();
    if (problem === null) {
      console.error("Daemon failed to start. Check the log:");
      console.error(`  ${process.platform === "win32" ? "type" : "cat"} "${LOG_FILE}"`);
    } else {
      // It ran without one (engram#679), so what it said is gone.
      console.error(`Daemon failed to start, and its log can't be written (${problem}). To see why, run it here:`);
      console.error("  engram start --foreground");
    }
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

/**
 * Record whether capture is on, for the capture check after other commands
 * (autoEnableCapture). `command`: the one that was run.
 *
 * A config.json that can't be read isn't saved over (engram#673): it holds
 * the API key and the folders excluded from capture. Read leniently, as it
 * was, `engram stop` replaced it with only `autocapture`. Nothing is lost
 * by not recording "on": nothing turns capture off meanwhile, and the
 * banner before the command said what is wrong with the file.
 *
 * A save that fails never stops the command: the daemon is stopped or
 * started all the same. But it is said, with what fixes it (engram#681).
 * Not recording "off" means the next command starts the daemon again, so
 * the exit says that too. Not recording "on" over an "off" means no other
 * command starts it again after it stops; over anything else, nothing
 * changes, so nothing is said.
 */
async function recordCaptureIntent(v: "on" | "off", command: string): Promise<void> {
  let config: Config;
  try {
    config = await loadConfigStrict();
  } catch (err: unknown) {
    if (err instanceof ConfigUnreadable && err.empty) {
      printEmptyConfigNote();
      config = {};
    } else {
      if (v === "off") {
        // The daemon still stops, but capture comes back on with the next
        // command once the file is fixed: not all that was asked, so the
        // exit says so to a script that runs `engram stop`. In a ~/.engram
        // that can't be searched, it is the folder that needs the fix, not
        // the file (engram#723).
        process.exitCode = 1;
        const locked = err instanceof ConfigUnreadable ? lockedConfigDir(err) : null;
        const why = locked
          ? lockedDirReason("opening config.json")
          : err instanceof ConfigUnreadable
            ? err.message
            : "~/.engram/config.json can't be read";
        console.error(red(`Couldn't record that capture is off: ${why}.`));
        const again = `run 'engram ${command}' again, or the next engram command turns capture back on.`;
        if (locked) {
          console.error(dim(`  ${lockedDirFix(locked)}`));
          console.error(dim(`  Then ${again}`));
        } else {
          console.error(dim(`  Once it's fixed, ${again}`));
        }
      }
      return;
    }
  }
  const was = config.autocapture;
  try {
    config.autocapture = v;
    await saveConfig(config);
  } catch (err: unknown) {
    const { problem, fix } = saveFailure(err);
    if (v === "off") {
      process.exitCode = 1;
      console.error(red(`Couldn't record that capture is off: ${problem}.`));
      const again = `run 'engram ${command}' again, or the next engram command turns capture back on.`;
      if (fix) {
        console.error(dim(`  To fix it, run: ${fix}`));
        console.error(dim(`  Then ${again}`));
      } else {
        console.error(dim(`  Once it's fixed, ${again}`));
      }
    } else if (was === "off" && !lockedDir()) {
      // In a ~/.engram that keeps them out (engram#723), `engram start` and
      // `engram install` start nothing, and say so with the fix.
      console.error(dim(`Note: couldn't record that capture is on: ${problem}.`));
      console.error(dim("  Until it is, other engram commands won't start the daemon again if it stops."));
      if (fix) {
        console.error(dim(`  To fix it, run: ${fix}`));
        console.error(dim(`  Then run 'engram ${command}' again.`));
      } else {
        console.error(dim(`  Once it's fixed, run 'engram ${command}' again.`));
      }
    }
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
  // Run as root, it would save the setting as root's (engram#682).
  if (refusedAsRoot("stop")) return;
  await recordCaptureIntent("off", "stop");
  const found = await findDaemon();
  if (found.state === "stopped") {
    // A supervisor waiting to start the daemon again after an error finds
    // this, and doesn't (engram#613).
    if (process.platform === "win32") writeStopRequest({ pid: null });
    if (lockedDir()?.search) {
      // What finds one can't be looked at (engram#723). The fix was said
      // with capture off, which couldn't be recorded either.
      console.error(
        red("No daemon was found, but one may still be running: ~/.engram's permissions keep you from opening its socket and PID file."),
      );
      process.exitCode = 1;
    } else {
      console.log("Daemon is not running.");
    }
    printUntiedRootWorkers([], foreignFiles());
    return;
  }
  if (found.state === "root") {
    // It can't be signalled, and launchd may run it (engram#680).
    printRootDaemon(found, "'engram stop' can't stop it.", { foreign: foreignFiles() });
    process.exitCode = 1;
    return;
  }
  if (found.pid === null) {
    console.error(red("The daemon isn't answering, and no process could be confirmed as it, so nothing was stopped."));
    console.error(dim(`  It may be busy, or still starting: try again in a minute.${itsLog()}`));
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
      console.error(dim(`  It may be busy, or still starting: try again in a minute.${itsLog()}`));
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
        // Root's, as a rule: `sudo engram start`, which a CLI from before
        // engram#653 ran as root (engram#659).
        if (process.platform !== "win32" && (err as NodeJS.ErrnoException).code === "EPERM") {
          console.error(dim(`  It runs as another user (root, if it was started with sudo). Stop it with: sudo kill ${pid}`));
        }
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
  // One running as root beside it still captures (engram#680): capture
  // hasn't stopped.
  const root = findRootDaemon();
  const foreign = foreignFiles();
  if (root !== null) {
    printRootDaemon(root, "'engram stop' can't stop it.", { foreign });
    process.exitCode = 1;
  }
  printUntiedRootWorkers([pid, root?.pid ?? null, root?.job?.pid ?? null], foreign);
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
async function printDbStats(foreign: ForeignFiles | null, config: Config | null): Promise<void> {
  if (!existsSync(DB_FILE)) return;
  try {
    const { DaemonDb } = await import("./db.js");
    const { accountFingerprint, keyFingerprint } = await import("./syncer.js");
    const { resolveBaseUrl } = await import("../server-url.js");
    const key = process.env.ENGRAM_API_KEY || config?.apiKey;
    // The account the daemon sends for, its key and server read together
    // (engram#685). With config.json unreadable and no ENGRAM_BASE_URL,
    // which server is unknown, and the daemon sends nothing.
    const server =
      config !== null || process.env.ENGRAM_BASE_URL?.trim() ? resolveBaseUrl(config ?? {}) : undefined;
    const mine = key && server ? accountFingerprint({ key, server }) : null;
    const db = new DaemonDb(DB_FILE, { readonly: true });
    let stats: ReturnType<typeof db.getStats>;
    try {
      // What the key queued before its server was recorded is sent too,
      // once the server confirms the key (see ownershipCandidates).
      stats = db.getStats(mine, key ? keyFingerprint(key) : undefined);
    } finally {
      db.close();
    }
    console.log(`${dim("Sessions captured:")} ${stats.sessionsMapped}`);
    console.log(`${dim("Pending sync:")}      ${plural(stats.pendingMessages, "message")}`);
    if (stats.heldMessages > 0) {
      console.log(
        `${dim("Held:")}              ${plural(stats.heldMessages, "message")} ` +
          dim(mine ? "(another account's — sent when it signs in again)" : "(sent when their account signs in)"),
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
    if (foreign?.files.some((name) => name.startsWith("daemon.db"))) {
      // engram#659: not the native module, and no start repairs it.
      console.log(dim("Local capture DB unreadable: it isn't yours, see below."));
    } else if (lockedDir()) {
      // engram#723: nor the native module. To read the database, SQLite
      // needs its -wal and -shm files beside it, and makes them when they
      // aren't there, as a stopped daemon leaves it.
      console.log(dim("Local capture DB unreadable: ~/.engram's own permissions get in the way."));
    } else {
      console.log(dim("Local capture DB unreadable (native module mismatch?) — the daemon rebuilds it on start."));
    }
  }
}

/**
 * engram#659, in `engram status`. `stopped`: the daemon isn't running, so
 * once they are the user's, it has to be started. `thenStart`: false when
 * that is said after the next warning instead, as ~/.engram keeps them out
 * too (engram#723), and it can't be started until both are fixed.
 */
function printForeignFilesWarning(foreign: ForeignFiles, stopped: boolean, blankBefore = true, thenStart = true): void {
  if (blankBefore) console.log("");
  console.log(red(`  ${foreignFilesProblem(foreign, stopped ? "stopped" : "running")}`));
  console.log(dim(`  ${foreignFilesFix(foreign)}`));
  if (thenStart && stopped && stopsCapture(foreign)) console.log(dim("  Then run: engram start"));
  console.log("");
}

/**
 * engram#723, in `engram status`. `stopped`: the daemon isn't running, or
 * can't be told to be, so once ~/.engram lets them in, it has to be started.
 */
function printLockedDirWarning(locked: LockedDir, stopped: boolean, blankBefore = true): void {
  if (blankBefore) console.log("");
  console.log(red(`  ${lockedDirProblem(locked, stopped ? "stopped" : "running")}`));
  console.log(dim(`  ${lockedDirFix(locked)}`));
  if (stopped) console.log(dim("  Then run: engram start"));
  console.log("");
}

/**
 * engram#680, in `engram status`: the daemon running as root for the user
 * that it found, or one besides theirs, from `sudo engram start` or `sudo
 * engram install` before engram#653; any other daemon running as root; and
 * Engram's job left in launchd's system domain. True when it said any.
 */
function printRootWarnings(found: DaemonFound, foreign: ForeignFiles | null): boolean {
  const job = found.state === "root" ? found.job : systemJob();
  const root = found.state === "root" ? found : findRootDaemon(undefined, job);
  const own = found.state === "stopped" || found.state === "root" ? null : found.pid;
  // The job's daemon is said with the job.
  const untied = untiedRootWorkers([own, root?.pid ?? null, job?.pid ?? null], foreign);
  if (root === null && untied.length === 0 && job === null) return false;
  console.log("");
  if (root !== null) {
    const { problem, fixes } = rootDaemonLines(root);
    const why =
      found.state === "root"
        ? "'engram stop' can't stop it, and no daemon of yours starts while it runs."
        : "It runs beside yours, and only one should.";
    console.log(red(`  ${problem} ${why}`));
    for (const fix of fixes) console.log(dim(`  ${fix}`));
    if (found.state === "root") {
      if (foreign) {
        console.log(red(`  ${foreignFilesProblem(foreign)}`));
        console.log(dim(`  ${foreignFilesFix(foreign, true)}`));
      }
      console.log(dim("  Then run: engram start"));
    }
  } else if (job !== null) {
    console.log(dim(`  ${systemJobLeft()}`));
  }
  if (untied.length > 0) console.log(red(`  ${untiedRootLine(untied)}`));
  console.log("");
  return true;
}

export async function daemonStatus(): Promise<void> {
  const found = await findDaemon();
  // Files in ~/.engram that are another user's (engram#659).
  const foreign = foreignFiles();
  // A ~/.engram whose own permissions keep the user out of it (engram#723).
  // One that can't be searched hides everything in it: that is said, not
  // what can't be read in it, which is every file. Nor can it be told
  // whether a daemon runs, unless launchd runs it: the exit says so.
  const locked = lockedDir();
  if (locked?.search) process.exitCode = 1;
  // A config.json that can't be read (engram#673): capture waits on it.
  const { config, problem: unread } = await inspectConfig();
  const problem = locked?.search ? null : unread;
  // A vault key that can't be read (engram#677): sends wait on it.
  const key = await keyFile(foreign, locked);

  if (found.state === "stopped") {
    // Its socket and PID file are how a daemon is found.
    console.log(
      locked?.search
        ? `${bold("Status:")} unknown — ~/.engram's permissions keep you from opening the files that say whether the daemon runs`
        : `${bold("Status:")} stopped`,
    );

    // Still show DB stats if available
    await printDbStats(foreign, config);
    const saidRoot = printRootWarnings(found, foreign);
    if (foreign) printForeignFilesWarning(foreign, true, !saidRoot, !locked);
    if (locked) printLockedDirWarning(locked, true, !saidRoot && !foreign);
    if (problem) printConfigWarning(problem);
    if (key instanceof VaultKeyUnreadable) printVaultKeyWarning(key, null);
    // A broken start-at-login entry is often why it's stopped. Files that
    // aren't the user's, said above, are why, when they stop it, and so is
    // a ~/.engram that keeps them out. With config.json unreadable, whether
    // 'engram stop' recorded capture off can't be told.
    const startsAtLogin = printAutoStart();
    if (startsAtLogin && !stopsCapture(foreign) && !locked && config !== null && config.autocapture !== "off") {
      // Not stopped by 'engram stop', which records autocapture "off", and
      // started at sign-in, so it stopped by itself (engram#613).
      console.log(dim("  It should be running: start at login is on. It may have stopped after an error."));
      // Without its log (engram#679), what it said is in the journal on
      // Linux, and gone on macOS.
      const linux = process.platform === "linux";
      console.log(
        dim(
          logProblem() === null
            ? `  The end of its log says why: ${LOG_FILE}`
            : linux
              ? "  The end of its output says why: journalctl --user -u engram"
              : "  Its log can't be written: 'engram start --foreground' shows why it stops.",
        ),
      );
      console.log(dim("  Run 'engram start' to start it again."));
    }
    if (startsAtLogin) await printLoginVaultKeyWarning();
    // Not "will run without it": in a ~/.engram that keeps them out, it
    // doesn't run at all, which is said above.
    if (logProblem() !== null && !locked) printLog(false);
    return;
  }

  if (found.state === "stopping") {
    console.log(`${bold("Status:")} stopping (pid ${found.pid})`);
  } else if (found.state === "root") {
    console.log(`${bold("Status:")} running as root (pid ${found.pid}), started with sudo`);
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

  await printDbStats(foreign, config);
  // With one running as root, what it made is said with it.
  const saidRoot = printRootWarnings(found, foreign);
  const ownDaemon = found.state !== "root";
  if (foreign && ownDaemon) printForeignFilesWarning(foreign, false, !saidRoot);
  if (locked && ownDaemon) printLockedDirWarning(locked, false, !saidRoot && !foreign);

  // status.json can't be read either in a ~/.engram that can't be
  // searched: what it says is the same as with none.
  const syncStatus = readStatus();
  printHostStatus(
    locked?.search && ownDaemon
      ? "~/.engram, see above"
      : problem
        ? "config.json, see below"
        : syncStatus.signed_out_at
          ? "signed out"
          : undefined,
  );

  // The daemon has no vault key, and the vault holds secrets (engram#698):
  // said with what to do, which is what the warning below would say.
  const keyMissing = await vaultKeyMissing(syncStatus, key);

  // Show sync health warnings
  printSyncWarnings(syncStatus, problem, key, keyMissing);

  // One running as root can write to it, and does. One running in a
  // ~/.engram that can't be searched opened it as it started, and goes on
  // writing to it: no one else can open it then (engram#723).
  if (found.state === "root" || locked?.search) console.log(`${dim("Log:")} ${LOG_FILE}`);
  else printLog(true, found.pid, ownDaemon ? locked?.command : undefined, found.state === "running" ? found.output : undefined);

  if (printAutoStart(found) && !keyMissing) await printLoginVaultKeyWarning();
}

/**
 * Print how the daemon starts at login; true when it is set to and should
 * work. What it says to run works whether the daemon runs or not: `engram
 * start` finds a running daemon and repairs nothing, and status is mostly
 * read while it runs (engram#651).
 *
 * `found`: the daemon that runs. Under the line, when start at login is on
 * and launchd or systemd doesn't run that daemon, though it could: it won't
 * be started again after a crash (engram#692, engram#689).
 */
function printAutoStart(found?: DaemonFound): boolean {
  const { on, line, after = [] } = autoStart();
  if (line !== null) console.log(line);
  for (const more of after) console.log(more);
  // On: launchd hasn't the job switched off, as autoStart asked, or the
  // systemd unit is enabled.
  if (on && found) printOutsideManager(found, true);
  return on;
}

/** How the daemon starts at login, as `engram status` says it. */
interface AutoStart {
  /** It is set to, and should work. */
  on: boolean;
  /** What status says of it: null when Engram has nothing there. */
  line: string | null;
  /** Said under it. */
  after?: string[];
}

function autoStart(): AutoStart {
  if (process.platform === "darwin") return launchdAutoStart(readPlist());
  if (process.platform === "linux") return systemdAutoStart(readUnit());

  const entry = readRunEntry();
  if (entry === null) return { on: false, line: null };
  // Said before broken, as on macOS and Linux: one switched off doesn't
  // start at sign-in either way, and 'engram install' switches it back on.
  if (switchedOffInStartupApps()) {
    return {
      on: false,
      line:
        `${dim("Auto-start:")} off — switched off in Windows Startup apps` +
        dim("  ('engram install' turns it back on)"),
    };
  }
  if (runEntryBroken(entry)) {
    return {
      on: false,
      line: `${dim("Auto-start:")} enabled (Windows sign-in)` + red("  — broken, run 'engram install' to repair"),
    };
  }
  return {
    on: true,
    line:
      `${dim("Auto-start:")} enabled (Windows sign-in)` +
      (runEntryOutdated(entry) ? red("  — outdated config, run 'engram install' to update") : ""),
  };
}

/** autoStart for the launchd agent: nothing when there is none. */
function launchdAutoStart(plist: PlistState): AutoStart {
  if (plist.kind === "none") return { on: false, line: null };
  // A plist in a folder that isn't the user's can't be rewritten or removed
  // (engram#715): said whatever its state, as it is what 'engram install'
  // and 'engram uninstall' would stop at.
  const notYours = launchAgentsNotYours();
  const after =
    notYours === null
      ? []
      : [
          red(`  ${launchAgentsWhose(notYours)}, so Engram can't update or remove its launchd agent.`),
          dim(`  Make it yours with: ${LAUNCH_AGENTS_FIX}`),
        ];
  // Said before broken or outdated: 'engram start' won't repair a job the
  // user switched off (engram#654).
  if (agentDisabled() === true) {
    return {
      on: false,
      line: `${dim("Auto-start:")} off — disabled in launchd` + dim("  ('engram install' turns it back on)"),
      after,
    };
  }
  if (plist.broken) {
    return {
      on: false,
      line: `${dim("Auto-start:")} enabled (launchd)` + red("  — broken, run 'engram install' to repair"),
      after,
    };
  }
  return {
    on: true,
    line:
      `${dim("Auto-start:")} enabled (launchd)` +
      (plist.outdated ? red("  — outdated config, run 'engram install' to update") : ""),
    after,
  };
}

/** autoStart for the systemd unit: nothing when there is none of ours. */
function systemdAutoStart(unit: UnitState): AutoStart {
  if (unit.kind !== "ours") return { on: false, line: null };
  if (!unit.enabled) {
    return {
      on: false,
      line: `${dim("Auto-start:")} off — disabled with systemctl` + dim("  ('engram install' turns it back on)"),
    };
  }
  if (unit.broken) {
    return {
      on: false,
      line: `${dim("Auto-start:")} enabled (systemd)` + red("  — broken, run 'engram install' to repair"),
    };
  }
  return {
    on: true,
    line:
      `${dim("Auto-start:")} enabled (systemd)` +
      (unit.outdated ? red("  — outdated config, run 'engram install' to update") : ""),
  };
}

/**
 * engram#673, in `engram status`: config.json can't be read, so capture
 * waits on it, and commands that save settings won't save over it.
 */
function printConfigWarning(problem: ConfigUnreadable): void {
  console.log("");
  console.log(red(`  WARNING: ${configProblemSummary(problem.message)}`));
  if (problem.empty) {
    console.log(dim("  Add back any folders you had excluded ('engram exclude add <path>'),"));
    console.log(dim("  then sign in again ('engram login')."));
  } else {
    console.log(dim("  Fix the file: it holds your API key and the folders you excluded, so Engram"));
    console.log(dim("  won't save over it. To start over instead: run 'engram stop', remove it, add"));
    console.log(dim("  back the folders you excluded ('engram exclude add <path>'), then 'engram login'."));
  }
  console.log("");
}

/**
 * What ~/.engram/vault-key holds, read as the daemon reads it (engram#677):
 * a key, nothing, or why no key can be read from it. "foreign": it can't be
 * read, and is another user's, which printForeignFilesWarning says.
 * "locked": nothing in ~/.engram can be opened, nor told to be there, which
 * printLockedDirWarning says (engram#723).
 */
type KeyFile = "key" | "none" | "foreign" | "locked" | VaultKeyUnreadable;

async function keyFile(foreign: ForeignFiles | null, locked: LockedDir | null): Promise<KeyFile> {
  const state = await vaultKeyFileState();
  if (!(state instanceof VaultKeyUnreadable)) return state;
  if (locked?.search) return "locked";
  return foreign?.files.includes("vault-key") ? "foreign" : state;
}

/**
 * engram#677, in `engram status`: no key can be read from ~/.engram/vault-key.
 * `held`: the daemon's status, while it holds sends for the key.
 */
function printVaultKeyWarning(problem: VaultKeyUnreadable, held: SyncStatus | null): void {
  console.log("");
  console.log(red(`  WARNING: ${problem.message}.`));
  // A sentence to a line: the one for a key that is gone is long.
  for (const line of vaultKeyFix(problem).split(/(?<=\.) /)) console.log(dim(`  ${line}`));
  // ENGRAM_VAULT_KEY wins over the file for commands run in this shell, not
  // for the daemon, which launchd and systemd start without it. A file that
  // is gone is no key to commands: they run without one.
  const envKey = Boolean(process.env.ENGRAM_VAULT_KEY) && problem.kind !== "gone";
  const refused = !envKey && problem.kind !== "gone";
  if (held) {
    console.log(dim("  Meanwhile, messages wait here rather than be sent with your vault's secrets"));
    console.log(dim(`  in them${refused ? ", and commands that need the key won't run" : ""}. Nothing is lost.`));
    if (held.pending_messages > 0) {
      console.log(red(`  ${plural(held.pending_messages, "message")} waiting to sync`));
    }
    if (held.last_error_at) console.log(dim(`  Last error: ${held.last_error_at}`));
  } else if (refused) {
    console.log(dim("  Meanwhile, commands that need the key won't run."));
  }
  if (envKey) console.log(dim("  Commands run here use ENGRAM_VAULT_KEY instead, which wins over the file."));
  console.log("");
}

/**
 * engram#690: ENGRAM_VAULT_KEY is set here, and ~/.engram/vault-key doesn't
 * hold its key. A daemon started at login reads the file: launchd never
 * gives it a shell's variables, and systemd and Windows may not. Without
 * the key, it captures without the vault's values removed (scrubber.ts);
 * with another key, without those encrypted with this one. Nothing said for
 * a variable that holds no key, or a file that can't be read, which
 * printVaultKeyWarning says (engram#677). `startsAtLogin`: whether the
 * daemon starts at login, asked only when there is something to say, as on
 * macOS that asks launchd.
 */
async function printLoginVaultKeyWarning(startsAtLogin: () => boolean = () => true): Promise<void> {
  const state = await envVaultKeyState();
  if (state !== "none" && state !== "different") return;
  if (!startsAtLogin()) return;
  console.log("");
  if (state === "none") {
    console.log(red("  WARNING: ENGRAM_VAULT_KEY is set here, but ~/.engram/vault-key isn't there."));
    console.log(dim("  A daemon started at login may not get this shell's variables. Then it has no"));
    console.log(dim("  vault key, and your vault's secrets aren't removed from what it captures."));
    console.log(dim("  To save the key there, readable only by you: engram vault save-key"));
  } else {
    console.log(red("  WARNING: ~/.engram/vault-key holds a different vault key from ENGRAM_VAULT_KEY."));
    console.log(dim("  A daemon started at login may not get this shell's variables. Then it uses the"));
    console.log(dim("  file's key, and secrets encrypted with ENGRAM_VAULT_KEY's aren't removed from"));
    console.log(dim("  what it captures. If ENGRAM_VAULT_KEY's key is the right one:"));
    console.log(dim("  engram vault save-key --force (the file's key is backed up first)."));
    console.log(dim("  If the file's is, unset ENGRAM_VAULT_KEY."));
  }
  console.log("");
}

/**
 * engram#698: the daemon has no vault key, and the account's vault holds
 * secrets: how many, and whether ENGRAM_VAULT_KEY holds a key to save. Not
 * while ~/.engram/vault-key is there: the daemon reads it before its next
 * send, or holds sends while it can't (printVaultKeyWarning). Not while
 * signed out: nothing is captured then.
 */
interface KeyMissing {
  secrets: number;
  envKey: boolean;
}

async function vaultKeyMissing(status: SyncStatus, key: KeyFile): Promise<KeyMissing | null> {
  const secrets: unknown = status.vault_key_missing?.secrets;
  if (typeof secrets !== "number" || !Number.isSafeInteger(secrets) || secrets <= 0) return null;
  const keyHeld = status.error_type === "vault_key" && status.health !== "healthy";
  if (status.vault_key !== null || key !== "none" || keyHeld || status.signed_out_at) return null;
  return { secrets, envKey: (await envVaultKeyState()) === "none" };
}

/**
 * engram#698, in `engram status`. A key saved now is read before the next
 * send: no restart.
 */
function printVaultKeyMissingWarning({ secrets, envKey }: KeyMissing): void {
  const one = secrets === 1;
  console.log("");
  console.log(red(`  WARNING: The daemon has no vault key, and your vault has ${plural(secrets, "secret")}.`));
  console.log(dim(`  Without the key, it can't remove ${one ? "its value" : "their values"} from what it captures before`));
  console.log(dim("  sending it."));
  if (envKey) {
    console.log(dim("  To save ENGRAM_VAULT_KEY's key for it: engram vault save-key"));
  } else {
    console.log(dim("  Put your vault key in ~/.engram/vault-key, or run 'engram vault save-key'"));
    console.log(dim("  from a shell where ENGRAM_VAULT_KEY holds it."));
  }
  console.log(dim("  The daemon reads it before its next send: no restart needed."));
  console.log("");
}

/**
 * engram#694, in `engram status`: the daemon holds sends for secrets its
 * vault key doesn't decrypt, until each decrypts, or is gone. It decrypts
 * none of the vault's secrets, or did when the hold began and some now:
 * saved again one at a time, they hold until the last. Then the key they
 * were saved with isn't the fix: the others don't decrypt with it. Its key
 * is the file's, or ENGRAM_VAULT_KEY's, which it read when it started:
 * then setting the variable again takes a restart.
 */
function printVaultMismatchWarning(status: SyncStatus): void {
  const secrets = status.vault_undecryptable?.secrets ?? 0;
  const decrypted = status.vault_undecryptable?.decrypted ?? 0;
  const one = secrets === 1;
  const they = one ? "it was" : "they were";
  console.log("");
  console.log(
    red(
      decrypted > 0
        ? `  WARNING: ${secrets} of your vault's ${secrets + decrypted} secrets ${one ? "doesn't" : "don't"} decrypt with your vault key.`
        : one
          ? "  WARNING: Your vault key doesn't decrypt your vault's secret."
          : `  WARNING: Your vault key doesn't decrypt any of your vault's ${secrets > 1 ? `${secrets} ` : ""}secrets.`,
    ),
  );
  console.log(dim(`  ${one ? "It was" : "They were"} saved with another key, so the daemon can't remove ${one ? "it" : "them"} from`));
  console.log(dim("  what it captures. Meanwhile, messages wait here rather than be sent with your"));
  console.log(dim("  vault's secrets in them. Nothing is lost. To send what waits, do one of these:"));
  if (decrypted > 0) {
    // The others decrypt with this key, and wouldn't with that one.
  } else if (status.vault_key === "env") {
    console.log(dim(`    Set ENGRAM_VAULT_KEY to the key ${they} saved with, then run`));
    console.log(dim("    'engram stop' and 'engram start' from that shell."));
  } else {
    console.log(dim(`    Put the key ${they} saved with in ~/.engram/vault-key.`));
  }
  console.log(dim(`    Save ${one ? "it" : "each"} again with this key: engram vault set <NAME>`));
  // Not "whose key is lost": one still in use, deleted, is no longer
  // removed from what the daemon captures. Saved again, it is.
  console.log(dim(`    Delete ${one ? "it, if you no longer use it" : "each you no longer use"}: engram vault delete <NAME>`));
  if (decrypted > 0) {
    console.log(dim("  'engram vault list --check' shows which. Then the daemon sends what it held"));
    console.log(dim("  within 5 minutes."));
  } else {
    console.log(dim(`  'engram vault list' lists ${one ? "it" : "them"}. Then the daemon sends what it held within`));
    console.log(dim("  5 minutes."));
  }
  if (status.pending_messages > 0) {
    console.log(red(`  ${plural(status.pending_messages, "message")} waiting to sync`));
  }
  // Held with nothing waiting yet, the last error is another's.
  if (status.last_error_at && status.health !== "healthy") {
    console.log(dim(`  Last error: ${status.last_error_at}`));
  }
  console.log("");
}

/**
 * engram#694, in `engram status`: some of the vault's secrets don't decrypt
 * with the daemon's vault key, and the others do. Sends go on: the key
 * these were saved with would leave the others out instead. Those it read
 * before, with a key it had then, it still removes, until it restarts.
 * Putting that key back isn't the fix: the others don't decrypt with it.
 */
function printVaultUndecryptableWarning(found: { secrets: number; unscrubbed: number }): void {
  const { secrets, unscrubbed } = found;
  const one = secrets === 1;
  console.log("");
  console.log(red(`  WARNING: ${plural(secrets, "secret")} in your vault ${one ? "doesn't" : "don't"} decrypt with your vault key.`));
  if (unscrubbed >= secrets) {
    console.log(dim(`  ${one ? "It was" : "They were"} saved with another key, so the daemon can't remove ${one ? "it" : "them"} from`));
    console.log(dim("  what it captures before sending it."));
  } else if (unscrubbed === 0) {
    console.log(dim(`  ${one ? "It was" : "They were"} saved with another key. The daemon still removes ${one ? "it" : "them"} from what`));
    console.log(dim(`  it captures, with what it read before, but can't once it restarts.`));
  } else {
    console.log(dim(`  They were saved with another key. The daemon can't remove ${unscrubbed} of them from`));
    console.log(dim("  what it captures before sending it, and the others only until it restarts."));
  }
  console.log(dim(`  Save ${one ? "it" : "each"} again with this key (engram vault set <NAME>), or delete ${one ? "it if you" : "each you"}`));
  console.log(dim(`  no longer use${one ? " it" : ""} (engram vault delete <NAME>). 'engram vault list --check'`));
  console.log(dim("  shows which don't decrypt."));
  console.log("");
}

/**
 * `problem`: config.json can't be read (engram#673), said above. `key`:
 * what ~/.engram/vault-key holds now (engram#677). `keyMissing`: the daemon
 * has no vault key for the vault's secrets (engram#698).
 */
function printSyncWarnings(
  status: SyncStatus,
  problem: ConfigUnreadable | null,
  key: KeyFile,
  keyMissing: KeyMissing | null = null,
): void {
  if (problem) printConfigWarning(problem);

  // Sends wait while the daemon can't read the vault key, and go on waiting
  // once the file is gone (scrubber.ts). Nothing is sent while signed out.
  const keyHeld = status.error_type === "vault_key" && status.health !== "healthy" && !status.signed_out_at;
  const keyProblem =
    key instanceof VaultKeyUnreadable
      ? key
      : keyHeld && key === "none"
        ? new VaultKeyUnreadable("isn't there any more", "gone")
        : null;
  if (keyProblem) printVaultKeyWarning(keyProblem, keyHeld ? status : null);
  // The file is gone, and the daemon had read a key from it (engram#693): it
  // goes on with that key, and the secrets read with it, until it restarts.
  if (status.vault_key === "file" && key === "none" && !keyHeld) {
    console.log("");
    console.log(red("  WARNING: ~/.engram/vault-key isn't there any more."));
    console.log(dim("  The daemon still removes your vault's secrets from what it captures, with the"));
    console.log(dim("  key it read before. When it restarts, it starts without one: put the key back"));
    console.log(dim("  if you still use the vault."));
    console.log("");
  }

  // No key saved (engram#594): the daemon runs, but captures and sends
  // nothing until one is. Nothing queued is lost meanwhile.
  if (status.signed_out_at) {
    // With config.json unreadable, whether a key is saved can't be told,
    // and signing in has to wait for the fix: said above, instead.
    if (!problem) {
      console.log("");
      console.log(red("  Signed out — capture is paused and nothing is sent."));
      console.log(dim("  Run 'engram auth login' to resume. Queued messages stay on this machine."));
      console.log(dim(`  Since: ${status.signed_out_at}`));
      console.log("");
    }
    return;
  }

  // Capture comes before sending: what can't be queued here can't be sent
  // either, however healthy syncing is (engram#584). Waiting on a
  // config.json that can't be read is said above.
  if (status.capture_error && !(problem && status.capture_error.kind === "config")) {
    console.log("");
    if (status.capture_error.kind === "config") {
      // The daemon tries again on its own: 5 minutes apart at most.
      console.log(red("  Capture is waiting on ~/.engram/config.json, which reads fine now."));
      console.log(dim("  It picks up where it stopped within 5 minutes: nothing is skipped."));
    } else {
      console.log(red(`  WARNING: ${captureErrorSummary(status.capture_error)}`));
    }
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

  if (keyMissing) printVaultKeyMissingWarning(keyMissing);

  // Sends wait for secrets the daemon's vault key doesn't decrypt: said
  // below, or here while nothing waits yet. Some of them, with no hold:
  // sending goes on, said here (engram#694).
  const mismatchHeld = status.error_type === "vault_mismatch" && status.health !== "healthy";
  const held = status.vault_undecryptable?.held === true;
  if (status.vault_undecryptable && !mismatchHeld && !held) {
    printVaultUndecryptableWarning(status.vault_undecryptable);
  }

  if (status.health === "healthy") {
    if (held) printVaultMismatchWarning(status);
    if (status.last_sync_at) {
      console.log(`${dim("Last sync:")}        ${status.last_sync_at}`);
    }
    return;
  }

  // Waiting on the vault key: said above when it can't be read now. One
  // that is another user's is said with them, and gets the words below.
  if (status.error_type === "vault_key" && keyProblem) return;
  if (status.error_type === "vault_key" && key === "key") {
    console.log("");
    console.log(red("  Sending is waiting on ~/.engram/vault-key, which reads fine now."));
    console.log(dim("  The daemon reads it again within a minute, then sends what it held."));
    if (status.pending_messages > 0) {
      console.log(dim(`  ${plural(status.pending_messages, "message")} waiting to sync`));
    }
    console.log("");
    return;
  }
  if (mismatchHeld) {
    printVaultMismatchWarning(status);
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

// ── macOS: a launchd agent ──
//
// ~/Library/LaunchAgents/app.getengram.daemon.plist: launchd loads it when
// the user logs in and starts the daemon, and starts it again after a crash.
// See launchd.ts.

/**
 * The plist for this CLI: this Node, this build's worker, this home. Or why
 * there can't be one: a path with a control character in it, which a plist
 * can't hold. The reason has the path JSON-escaped, so it is safe to print.
 */
function plistForThisCli(): { text: string } | { error: string } {
  const node = nodePathForEntry();
  try {
    return {
      text: generatePlist({
        node,
        // A CLI installed with brew runs from a versioned keg too (engram#652).
        worker: throughOptLink(workerPath()),
        // None while it can't be written: launchd would never start the
        // daemon (engram#679).
        log: logProblem() === null ? LOG_FILE : null,
        home: homedir(),
        // launchd hands a job a bare PATH (/usr/bin:/bin:/usr/sbin:/sbin) —
        // npm is not on it. The ABI self-heal in preflight.ts shells out to
        // `npm rebuild better-sqlite3`, so without this it fails with
        // command-not-found at the exact moment it is needed. npm ships
        // beside the node binary, so node's own directory goes first.
        path: `${dirname(node)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      }),
    };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** The plist's text as it is now; null when there is none to read. */
function installedPlistText(): string | null {
  try {
    return readFileSync(plistPath(), "utf-8");
  } catch {
    return null;
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

/** "~/Library/LaunchAgents belongs to root, not to you" (engram#678). */
function launchAgentsWhose({ root }: { root: boolean }): string {
  return `~/Library/LaunchAgents belongs to ${root ? "root" : "another user"}, not to you`;
}

/**
 * Writing the plist failed because ~/Library/LaunchAgents isn't the user's
 * (engram#678): whether it is root's. Null when it failed for another
 * reason.
 */
function launchAgentsRefused(err: unknown): { root: boolean } | null {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code !== "EACCES" && code !== "EPERM") return null;
  return launchAgentsNotYours();
}

/** What repairLaunchdIfStale did. */
export type LaunchdRepair =
  /** Rewrote the plist, and reloaded the job. */
  | "repaired"
  /** Nothing: the plist is current, or left as it is. */
  | "unchanged"
  /** The plist needs rewriting, and ~/Library/LaunchAgents isn't the user's (engram#715). */
  | "refused"
  /**
   * Nothing, and it is broken: this CLI runs from a package runner's cache,
   * which nothing is pointed at (engram#665).
   */
  | "runner";

/**
 * Rewrite and reload a plist of ours that an older CLI wrote (engram#469),
 * or that can't start the daemon (engram#616): one launchd can't read, or
 * one naming a Node or a CLI that has since moved. Or one naming them in a
 * Homebrew version that the next upgrade removes (engram#652).
 *
 * Without this, a plist defect is permanent: `brew upgrade` / `npm i -g`
 * replaces the code but leaves the plist, so the machine keeps launching the
 * old entry point forever. That is how a self-heal shipped in 0.4.2 was still
 * inert on a 0.6.0 install. Runs on any daemon start; silent when current.
 *
 * One the user switched off in launchd is left as it is, as on Linux: only
 * `engram install` switches it back on (engram#654).
 *
 * In a ~/Library/LaunchAgents that isn't the user's, it can't be rewritten:
 * that is said, unless `quiet` (engram#715). It used to be left broken
 * without a word, while `engram status` said to run `engram install`,
 * which failed on it too. Auto-capture says it with the rest, and `engram
 * start --install` as it turns start at login on.
 *
 * From a CLI that a package runner runs from its cache, it is left as it
 * is (engram#665): the cache can be cleared at any time. "runner" when it
 * is broken, and not switched off, for the caller to say.
 */
export function repairLaunchdIfStale(plist?: PlistState, { quiet = false }: { quiet?: boolean } = {}): LaunchdRepair {
  if (process.platform !== "darwin") return "unchanged";
  const state = plist ?? readPlist();
  if (state.kind !== "ours") return "unchanged";
  if (!state.broken && !state.outdated) return "unchanged";
  if (runnerCacheOfThisCli() !== null) return state.broken && agentDisabled() !== true ? "runner" : "unchanged";
  // Only a source checkout run through tsx has no worker.js: the build ships it.
  if (!existsSync(workerPath())) return "unchanged";
  // Never fails the command it runs in: a plist that can't be made or
  // written is left as it is, and `engram install` says why.
  const made = plistForThisCli();
  if ("error" in made) return "unchanged";
  // One the user switched off is left as it is too: reloading it would stop
  // the daemon launchd still runs, if it runs one, and launchd wouldn't load
  // it again.
  if (agentDisabled() === true) return "unchanged";
  try {
    writePlistFile(made.text);
  } catch (err: unknown) {
    const notYours = launchAgentsRefused(err);
    if (notYours === null) return "unchanged";
    if (!quiet) {
      console.error(red(`Couldn't update start at login: ${launchAgentsWhose(notYours)}.`));
      console.error(dim(`  Make it yours with: ${LAUNCH_AGENTS_FIX}`));
      console.error(dim("  Then run: engram install"));
    }
    return "refused";
  }
  prepareLaunchdLog();
  // launchd keeps running the job it loaded until it is unloaded. One it
  // can't load now loads from the file at the next login.
  reloadAgent();
  console.log(`${bold("Updated auto-start configuration")} ${dim(`(plist v${PLIST_VERSION})`)}`);
  return "repaired";
}

function isLaunchdInstalled(): boolean {
  // Darwin only: CLIs before engram#602 wrote this plist on every platform,
  // and a stray copy must not read as "auto-start enabled" or send status
  // shelling out to launchctl on Windows.
  return process.platform === "darwin" && existsSync(plistPath());
}

/** A path as one word of a command line for the user to run. */
function shellWord(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`;
}

/**
 * Start at login on macOS, for `engram install` and `engram start
 * --install`: write the plist, switch the job on in launchd, and have
 * launchd load it, which starts the daemon (RunAtLoad). A job launchd has
 * loaded already isn't loaded again, so it starts no daemon: with `start`
 * (no daemon runs), launchd is asked to start one then (engram#691).
 * `again`: the command to run again, once the plist can be written.
 */
async function enableLaunchdStartAtLogin(start = false, again = "engram install"): Promise<void> {
  if (!existsSync(workerPath())) {
    // Only a source checkout run through tsx gets here: the build ships it.
    console.error(red(`Can't turn on start at login: ${workerPath()} is missing.`));
    process.exitCode = 1;
    return;
  }
  const made = plistForThisCli();
  if ("error" in made) {
    console.error(red("Can't turn on start at login: a launchd job can't hold one of the paths it needs."));
    console.error(dim(`  ${made.error}`));
    process.exitCode = 1;
    return;
  }
  const unchanged = installedPlistText() === made.text;
  if (!unchanged) {
    try {
      writePlistFile(made.text);
    } catch (err: unknown) {
      // engram#678: the error alone names a temporary file in the folder,
      // and not why.
      const notYours = launchAgentsRefused(err);
      if (notYours) {
        console.error(red(`Couldn't turn on start at login: ${launchAgentsWhose(notYours)}.`));
        console.error(dim(`  Make it yours with: ${LAUNCH_AGENTS_FIX}`));
        console.error(dim(`  Then run '${again}' again.`));
      } else {
        console.error(red("Couldn't turn on start at login."));
        console.error(dim(`  ${err instanceof Error ? err.message : String(err)}`));
      }
      process.exitCode = 1;
      return;
    }
  }
  prepareLaunchdLog();
  // Install is the user asking for start at login, so it switches the job
  // back on where they switched it off (engram#654). Where launchd won't take
  // that, the load below does it, with load -w.
  const switchedOn = agentDisabled() === false || enableAgent();
  // Loading the job starts the daemon (a second one finds the first and
  // exits, engram#612). One launchd has loaded already is loaded again only
  // when the plist changed: unloading it stops the daemon launchd runs.
  const loadedAlready = unchanged && switchedOn && agentLoaded();
  const failed = loadedAlready ? null : reloadAgent({ turnOn: true });
  if (failed !== null) {
    console.log(`Plist written to ${plistPath()}`);
    console.log(dim(`  launchctl: ${failed}`));
    console.log(`Run manually: launchctl load -w ${shellWord(plistPath())}`);
    return;
  }
  console.log(`${bold("Auto-start enabled")} — daemon will start on login`);
  console.log(`${dim("Plist:")} ${plistPath()}`);
  await printLoginVaultKeyWarning();
  // A job launchd had loaded already starts no daemon now: after `engram
  // stop`, its daemon exited 0, which KeepAlive doesn't start again
  // (engram#691). It is started as `engram start` starts it: through
  // launchd, which starts it again after a crash. Windows and Linux start
  // one here too.
  if (start && loadedAlready && !reportStart(await startInBackground())) process.exitCode = 1;
}

/**
 * Start at login when auto-capture turns capture on: add the agent when
 * there is none, and repair one of ours that is broken or outdated. Unlike
 * `engram install`, it leaves a job the user switched off in launchd off
 * (engram#654), as on Windows and Linux. Never fails the command it runs
 * after.
 *
 * "changed": it added or repaired the agent, and said so. "failed": it
 * couldn't add one, which autoEnableCapture says along with the rest.
 * "runner": there is none that works, and this CLI runs from a package
 * runner's cache, which nothing is pointed at (engram#665).
 */
function autoEnableLaunchdStartAtLogin(): "changed" | "unchanged" | "failed" | "runner" {
  const plist = readPlist();
  if (plist.kind === "ours") {
    const repair = repairLaunchdIfStale(plist, { quiet: true });
    return repair === "repaired" ? "changed" : repair === "refused" ? "failed" : repair;
  }
  // Only a source checkout run through tsx has no worker.js: the build ships it.
  if (!existsSync(workerPath())) return "unchanged";
  if (runnerCacheOfThisCli() !== null) return "runner";
  const made = plistForThisCli();
  if ("error" in made) return "failed";
  try {
    writePlistFile(made.text);
  } catch {
    return "failed";
  }
  prepareLaunchdLog();
  // launchd remembers a job switched off after its plist is gone. Said once:
  // from now on the plist is there, and current.
  if (agentDisabled() === true) {
    console.log(`${bold("Start at login is switched off")} in launchd`);
    console.log(dim("  Run 'engram install' to start the daemon when you log in."));
    return "changed";
  }
  loadAgent(); // one launchd can't load now loads at the next login
  console.log(`${bold("Auto-start enabled")} — daemon will start on login`);
  return "changed";
}

function uninstallLaunchd(): void {
  if (!isLaunchdInstalled()) {
    console.log("Launchd agent not installed.");
    return;
  }
  // The plist can't be removed from a folder that isn't the user's
  // (engram#715). launchd is left as it is, rather than stop the daemon it
  // runs now and start it again at the next login.
  const notYours = launchAgentsNotYours();
  if (notYours) {
    console.error(red(`Couldn't turn off start at login: ${launchAgentsWhose(notYours)}.`));
    console.error(dim(`  Make it yours with: ${LAUNCH_AGENTS_FIX}`));
    console.error(dim("  Then run 'engram uninstall' again."));
    process.exitCode = 1;
    return;
  }
  unloadAgent();
  try {
    rmSync(plistPath(), { force: true });
  } catch {
    console.error(red("Couldn't remove the launchd agent."));
    console.error(dim(`  Remove ${plistPath()} to turn start at login off.`));
    process.exitCode = 1;
    return;
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
 * Homebrew's Node goes by its opt link, which outlasts the version the next
 * `brew upgrade` removes (engram#652).
 */
function nodePathForEntry(): string {
  try {
    return throughOptLink(realpathSync.native(process.execPath));
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

/** The command line runEntryCommand writes: Node, then the sign-in entry. */
const RUN_ENTRY = /^"([^"]+)"\s+"([^"]+)"$/;

/** Either program the entry names is gone (Node moved, CLI uninstalled). */
function runEntryBroken(entry: string): boolean {
  const m = entry.match(RUN_ENTRY);
  return !m || !existsSync(m[1]) || !existsSync(m[2]);
}

/**
 * The entry starts the CLI from a package runner's cache, which can be
 * cleared at any time (engram#665): a CLI run that way wrote it, before
 * none did.
 */
function runEntryOutdated(entry: string): boolean {
  const m = entry.match(RUN_ENTRY);
  return m !== null && runnerCacheOf(m[2]) !== null;
}

/** Add the entry, or point it at this CLI. Null when reg did; else what reg said, to print. */
function writeRunEntry(): string | null {
  try {
    runReg([
      "add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ",
      "/d", runEntryCommand(nodePathForEntry(), loginStartPath()), "/f",
    ]);
    return null;
  } catch (err: unknown) {
    return commandFailure(err);
  }
}

/** Remove the entry. Null when reg did; else what reg said, to print. */
function deleteRunEntry(): string | null {
  try {
    runReg(["delete", RUN_KEY, "/v", RUN_VALUE, "/f"]);
    return null;
  } catch (err: unknown) {
    return commandFailure(err);
  }
}

/**
 * Point a broken entry at this CLI, the counterpart of repairLaunchdIfStale:
 * an entry naming a Node or a CLI that has since moved fails at every
 * sign-in without a word. And one naming a package runner's cache, which
 * can be cleared at any time (engram#665). A working entry is left as it
 * is. So is any, from a CLI that runs from such a cache: "runner" when it
 * is broken, and not switched off in Startup apps, for the caller to say.
 */
export function repairRunEntryIfStale(entry: string | null = readRunEntry()): Exclude<LaunchdRepair, "refused"> {
  if (entry === null) return "unchanged";
  const broken = runEntryBroken(entry);
  if (!broken && !runEntryOutdated(entry)) return "unchanged";
  if (runnerCacheOfThisCli() !== null) return broken && !switchedOffInStartupApps() ? "runner" : "unchanged";
  if (!existsSync(loginStartPath()) || writeRunEntry() !== null) return "unchanged";
  console.log(bold("Updated the start-at-login entry"));
  return "repaired";
}

/** The plist CLIs before engram#602 wrote off macOS too. */
function removeStrayPlist(): void {
  try {
    rmSync(plistPath(), { force: true });
  } catch {
    // nothing reads it on this OS
  }
}

// ── Linux: a systemd user unit (engram#615) ──
//
// ~/.config/systemd/user/engram.service, linked into default.target by
// `systemctl --user enable`: the user's service manager starts the daemon at
// login and again after a crash. See systemd.ts.

/**
 * The unit for this CLI: this Node, this build's worker, this home. Or why
 * there can't be one: a path with a control character in it, which a unit
 * can't hold. The reason has the path JSON-escaped, so it is safe to print.
 */
function unitForThisCli(): { text: string } | { error: string } {
  const node = nodePathForEntry();
  try {
    return {
      text: generateUnit({
        node,
        worker: throughOptLink(workerPath()),
        log: LOG_FILE,
        engramDir: ENGRAM_DIR,
        home: homedir(),
        path: `${dirname(node)}:/usr/local/bin:/usr/bin:/bin`,
      }),
    };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** The unit's text as it is now; null when there is none to read. */
function installedUnitText(): string | null {
  try {
    return readFileSync(unitPath(), "utf-8");
  } catch {
    return null;
  }
}

/**
 * The unit is ours, enabled and current, for this CLI (unitForThisCli), and
 * the daemon systemd starts from it has everything this command's
 * environment would give one (daemonEnvOverrides): systemd can run this
 * CLI's daemon (engram#689). No systemctl call. One the user disabled is
 * left to them: the daemon is spawned then, as before.
 */
function systemdRunsThisCli(): boolean {
  if (process.platform !== "linux" || daemonEnvOverrides()) return false;
  const unit = readUnit();
  if (unit.kind !== "ours" || !unit.enabled) return false;
  const made = unitForThisCli();
  return "text" in made && installedUnitText() === made.text;
}

/**
 * Rewrite an enabled unit of ours that names a Node or a CLI that has since
 * moved, or that an older CLI wrote, or that names them in a Homebrew version
 * (engram#652) or a package runner's cache (engram#665): the counterpart of
 * repairLaunchdIfStale and repairRunEntryIfStale. One the user disabled is
 * left as it is. So is any, from a CLI that runs from such a cache:
 * "runner" when it is broken, for the caller to say.
 */
export function repairSystemdUnitIfStale(unit: UnitState = readUnit()): Exclude<LaunchdRepair, "refused"> {
  if (process.platform !== "linux") return "unchanged";
  if (unit.kind !== "ours" || !unit.enabled) return "unchanged";
  if (!unit.broken && !unit.outdated) return "unchanged";
  if (runnerCacheOfThisCli() !== null) return unit.broken ? "runner" : "unchanged";
  // Only a source checkout run through tsx has no worker.js: the build ships it.
  if (!existsSync(workerPath())) return "unchanged";
  // Never fails the command it runs in: a unit that can't be made or written
  // is left as it is, and `engram install` says why.
  const made = unitForThisCli();
  if ("error" in made || !rewriteUnit(made.text)) return "unchanged";
  console.log(`${bold("Updated auto-start configuration")} ${dim(`(systemd unit v${UNIT_VERSION})`)}`);
  return "repaired";
}

/** A systemd user session: there is a user service manager, and it answers. */
function systemdSession(): boolean {
  const file = systemctlPath();
  return file !== null && systemdReachable(file);
}

/**
 * Start at login on Linux, for `engram install` and `engram start
 * --install`: write the unit, and enable it. `running`: a daemon runs, or
 * the caller starts one next, for what is said where there is no start at
 * login. `start`: start the daemon too, as `engram start` does: through
 * systemd, once the unit is enabled (engram#689).
 */
async function enableSystemdStartAtLogin(running: boolean, start = !running): Promise<void> {
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
  const made = unitForThisCli();
  if ("error" in made) {
    console.error(red("Can't turn on start at login: a systemd unit can't hold one of the paths it needs."));
    console.error(dim(`  ${made.error}`));
    process.exitCode = 1;
    return;
  }
  const failed = installUnit(systemctl, made.text);
  if (failed !== null) {
    console.error(red("Couldn't turn on start at login."));
    console.error(dim(`  systemctl: ${failed}`));
    process.exitCode = 1;
    return;
  }
  console.log(`${bold("Auto-start enabled")} — daemon will start when you log in (systemd)`);
  console.log(`${dim("Unit:")} ${unitPath()}`);
  await printLoginVaultKeyWarning();
  // Enabled, not started: systemd starts it from the next login on. The
  // daemon now is started as 'engram start' starts it: by systemd, unless
  // this shell's environment has settings systemd's daemon wouldn't
  // (engram#689); never beside a running one.
  if (start && !reportStart(await startInBackground())) {
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
 * one to. "runner": there is none that works, and this CLI runs from a
 * package runner's cache, which nothing is pointed at (engram#665).
 * autoEnableCapture says any of them along with the rest.
 */
function autoEnableSystemdStartAtLogin(): "changed" | "unchanged" | "failed" | "unavailable" | "runner" {
  const unit = readUnit();
  if (unit.kind === "foreign") return "unchanged";
  if (unit.kind === "ours") {
    const repair = repairSystemdUnitIfStale(unit);
    return repair === "repaired" ? "changed" : repair;
  }
  if (!existsSync(workerPath())) return "unchanged";
  const systemctl = systemctlPath();
  if (systemctl === null || !systemdReachable(systemctl)) return "unavailable";
  if (runnerCacheOfThisCli() !== null) return "runner";
  const made = unitForThisCli();
  if ("error" in made || installUnit(systemctl, made.text) !== null) return "failed";
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
 * whether a daemon is up right now. `again`: the command that asked, to
 * run again where something stops it.
 */
async function enableStartAtLogin(running: boolean, again = "engram install"): Promise<void> {
  if (process.platform === "darwin") {
    await enableLaunchdStartAtLogin(!running, again);
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
    process.exitCode = 1;
    return;
  }
  // Said here, as on macOS and Linux: status sends people to 'engram install'
  // to repair start at login, so this is where they learn why it can't be
  // (engram#651).
  const failed = writeRunEntry();
  if (failed !== null) {
    console.error(red("Couldn't add the Windows startup entry."));
    console.error(dim(`  reg: ${failed}`));
    console.error(dim(`  It goes in ${RUN_KEY} as "${RUN_VALUE}". Run 'engram install' to try again.`));
    process.exitCode = 1;
    return;
  }
  clearStartupSwitch();
  console.log(`${bold("Auto-start enabled")} — daemon will start when you sign in to Windows`);
  console.log(dim("  A console window flashes briefly at sign-in while it starts."));
  console.log(`${dim("Startup entry:")} ${RUN_KEY}\\${RUN_VALUE}`);
  await printLoginVaultKeyWarning();
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
 * "runner": there is none that works, and this CLI runs from a package
 * runner's cache, which nothing is pointed at (engram#665).
 */
function autoEnableWindowsStartAtLogin(): "changed" | "unchanged" | "failed" | "runner" {
  const entry = readRunEntry();
  if (entry !== null) {
    const repair = repairRunEntryIfStale(entry);
    return repair === "repaired" ? "changed" : repair;
  }
  // Only a source checkout run through tsx has no login-start.js: the build ships it.
  if (!existsSync(loginStartPath())) return "unchanged";
  if (runnerCacheOfThisCli() !== null) return "runner";
  if (writeRunEntry() !== null) return "failed";
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
    } else {
      const failed = deleteRunEntry();
      if (failed !== null) {
        console.error(red("Couldn't remove the Windows startup entry."));
        console.error(dim(`  reg: ${failed}`));
        console.error(dim(`  Remove "${RUN_VALUE}" from ${RUN_KEY}, or switch it off under Startup apps.`));
        process.exitCode = 1;
        return;
      }
      clearStartupSwitch();
      console.log(`${bold("Auto-start disabled")} — the Windows startup entry is removed`);
    }
    const state = (await findDaemon()).state;
    if (state !== "stopped" && state !== "root") {
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
    const state = (await findDaemon()).state;
    if (state !== "stopped" && state !== "root") {
      console.log(dim("  The daemon keeps running until 'engram stop' or sign-out."));
    }
    return;
  }
  console.log(`Start at login isn't set up on ${platformLabel()}, so there is nothing to remove.`);
}

export async function daemonInstall(): Promise<void> {
  if (refusedAsRoot("install")) return;
  if (refusedFromRunnerCache("engram install")) return;
  await recordCaptureIntent("on", "install");
  // A daemon that is stopping isn't counted: on Windows a new worker is
  // started, which takes over once that one has gone. On macOS and Linux
  // install waits for it to exit first, as `engram start` does: launchd or
  // systemd takes one it runs for its daemon, still running, and would start
  // none in its place (engram#691, engram#689).
  const platform = process.platform;
  const managed = platform === "darwin" || platform === "linux";
  let found = await findDaemon();
  if (managed) found = await whileStopping(found);
  const running = found.state === "running" || found.state === "unresponsive";
  // Files in ~/.engram that are another user's (engram#659). Unless one
  // runs already, start at login would start a daemon that stops at once:
  // it isn't turned on. Nor, whether one runs or not, in a ~/.engram whose
  // own permissions keep the user out of it (engram#723): the daemon
  // launchd or systemd would start, now and at each login, would stop at
  // once.
  const foreign = foreignFiles();
  const locked = lockedDir();
  if (found.state === "root") {
    // The daemon start at login started would exit at once (engram#680).
    printRootDaemon(found, "Start at login wasn't turned on: no daemon of yours starts while it runs.", {
      foreign,
      again: "engram install",
    });
    process.exitCode = 1;
    return;
  }
  if (foreign || locked) {
    const stops = (!running && stopsCapture(foreign)) || locked !== null;
    if (foreign) printForeignFiles(foreign, running ? "running" : "stopped", stops && !locked ? "install" : undefined);
    if (locked) printLockedDir(locked, running ? "running" : "stopped", "engram install");
    if (stops) {
      process.exitCode = 1;
      return;
    }
  }
  if (found.state === "stopping" && managed) {
    // Start at login all the same, but no start now: launchd or systemd
    // would take the one stopping for theirs if they run it. (A job loaded
    // now starts one, which waits for that one to go, engram#612.)
    if (platform === "darwin") await enableLaunchdStartAtLogin();
    else await enableSystemdStartAtLogin(false, false);
    console.error(red(`The daemon is still stopping (pid ${found.pid}). Run 'engram start' in a moment.`));
    process.exitCode = 1;
    return;
  }
  await enableStartAtLogin(running);
  // A daemon that runs stays the one that runs: one launchd starts as the
  // agent loads finds it and exits (engram#612). Said when launchd or
  // systemd doesn't run it, as `engram start --install` says it (engram#692).
  printOutsideManager(found);
}

/**
 * Auto-capture is the product default: a successful interactive login
 * turns the capture daemon on and enables start-at-login, loudly, with a
 * one-line off switch. Never fatal — login must succeed even if the
 * daemon can't start. Skipped for scripted logins (no TTY), when
 * ENGRAM_NO_AUTOCAPTURE is set, and for root run for someone else, which
 * would set capture up for root (engram#653).
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
  // It would start the daemon and start at login for root (engram#653).
  if (rootForAnotherUser()) {
    if (after === "login") {
      console.log(dim("  Auto-capture runs as you, not as root, so it wasn't turned on: sign in again without sudo."));
    }
    return;
  }
  try {
    // Files in ~/.engram that are another user's (engram#659): a daemon
    // started now would stop at once, after every command. The banner
    // before the command said why.
    if (stopsCapture(foreignFiles())) {
      if (after === "login") {
        console.log(
          dim(`  Auto-capture wasn't turned on: files in ~/.engram aren't yours. Make them yours with: ${OWNERSHIP_FIX}`),
        );
      }
      return;
    }
    // A ~/.engram whose own permissions keep the user out of it
    // (engram#723): likewise, and the daemon would say so in a desktop
    // notification as it stops, after every command.
    const locked = lockedDir();
    if (locked) {
      if (after === "login") {
        console.log(dim(`  Auto-capture wasn't turned on: ${lockedDirProblem(locked)} ${lockedDirFix(locked)}`));
      }
      return;
    }
    // Strict (engram#673): one that can't be read may say capture is off.
    // A daemon started now would only wait on it; the banner said why.
    const config = await loadConfigStrict();
    if (config.autocapture === "off") return; // user said stop; respect it
    if (!(process.env.ENGRAM_API_KEY ?? config.apiKey)) return; // nothing to capture into
    let changed = false;
    const found = await findDaemon(500);
    // One runs as root for them (engram#680): none of theirs would start
    // beside it, and start at login is left as it is. After other commands,
    // `engram status` says so.
    if (found.state === "root") {
      if (after === "login") {
        const { problem, fixes } = rootDaemonLines(found);
        console.log(dim(`  Auto-capture wasn't turned on. ${problem}`));
        for (const fix of fixes) console.log(dim(`  ${fix}`));
        console.log(dim("  Then run: engram start"));
      }
      return;
    }
    // When launchd's start at login couldn't be set up because
    // ~/Library/LaunchAgents isn't the user's (engram#678): whose it is.
    let launchAgents = null as { root: boolean } | null;
    const autoEnableStartAtLogin = (): "changed" | "unchanged" | "failed" | "unavailable" | "runner" => {
      if (platform === "win32") return autoEnableWindowsStartAtLogin();
      if (platform !== "darwin") return autoEnableSystemdStartAtLogin();
      const result = autoEnableLaunchdStartAtLogin();
      if (result === "failed") launchAgents = launchAgentsNotYours();
      return result;
    };
    // On macOS and Linux, with no daemon at all, start at login first: then
    // launchd or systemd starts the daemon, and starts it again after a crash
    // (engram#641, engram#689). Not with settings in this environment that
    // their daemon wouldn't have: the daemon is spawned then, as before.
    const managerFirst = platform !== "win32" && found.state === "stopped" && !daemonEnvOverrides();
    let startAtLogin = managerFirst ? autoEnableStartAtLogin() : undefined;
    if (found.state === "stopped" || found.state === "stopping") {
      // On Windows through the supervisor, as at sign-in, so a worker that
      // exits with an error is started again (engram#613). Nothing waits on
      // it here, so it is never asked to report a failed start.
      if (platform === "win32") spawnSupervisor();
      else if (!(managerFirst && serviceManager()?.start() === null)) spawnWorker();
      changed = true;
      await sleep(500);
    }
    startAtLogin ??= autoEnableStartAtLogin();
    if (startAtLogin === "changed") changed = true;
    const startAtLoginFailed = startAtLogin === "failed";
    const startAtLoginUnavailable = startAtLogin === "unavailable";
    // A CLI a package runner runs from its cache sets none up (engram#665).
    const runner = startAtLogin === "runner" ? runnerCacheOfThisCli() : null;
    if (after === "command" && !changed) return;
    // Said with the rest, not after every command while it keeps failing:
    // after a command, that is when the daemon had to be started, which is
    // what start at login would have done.
    if (startAtLoginFailed) {
      // A ~/Library/LaunchAgents that isn't the user's (engram#678): what
      // makes it theirs. Start at login is set up once it is, after the
      // next command.
      console.log(
        dim(
          launchAgents
            ? `  Couldn't set up start at login: ${launchAgentsWhose(launchAgents)}. Make it yours with: ${LAUNCH_AGENTS_FIX}`
            : "  Couldn't turn on start at login. Run 'engram install' to try again.",
        ),
      );
    }
    console.log(
      `${bold("Auto-capture is on")} — conversations from supported agents on this machine save to your Engram.`,
    );
    if (startAtLoginUnavailable) {
      console.log(
        dim("  Start at login isn't available here (no systemd user session): run 'engram start' after a restart."),
      );
    }
    if (runner !== null) {
      console.log(
        dim(`  The daemon won't start at login: this Engram runs from ${runner}, which can be cleared at any time.`),
      );
      console.log(dim(`  To start it at login, install the CLI: ${INSTALL_CLI} && engram install`));
    }
    console.log(dim("  Turn off anytime: engram stop && engram uninstall"));
    // When start at login is on: the daemon it starts reads the file
    // (engram#690). Not one the user switched off, or never there.
    await printLoginVaultKeyWarning(() => autoStart().on);
  } catch {
    // Non-fatal by design: capture is a convenience, login is the job.
  }
}

export async function daemonUninstall(): Promise<void> {
  // Run as root, it would save the setting as root's (engram#682).
  if (refusedAsRoot("uninstall")) return;
  await recordCaptureIntent("off", "uninstall");
  await disableStartAtLogin();
}
