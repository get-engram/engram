/**
 * engram#680 — a daemon left running as root in the user's ~/.engram.
 *
 * Before engram#653, `sudo engram start` started the daemon as root, and
 * `sudo engram install` loaded its launchd job into the system domain,
 * where it runs as root. macOS keeps HOME under sudo, so that daemon
 * captures into the user's ~/.engram and makes files there that their own
 * daemon can't write. The user can't signal it: `engram stop` failed, and
 * a CLI from before this change took its PID file for a dead daemon's and
 * removed it, then started a second daemon beside it.
 *
 * Now its PID file is kept, and `engram status`, `start`, `stop` and
 * `install` say how to stop it. While it runs, no other daemon is started:
 * two would capture the same transcripts (see claimDaemonLock).
 */

import { daemonInPidFile, rootDaemonPid, rootWorkerPids } from "./instance.js";
import { SYSTEM_JOB_UNLOAD, systemJob, type SystemJob } from "./launchd.js";
import type { ForeignFiles } from "./ownership.js";

/** A daemon running as root for this user, and Engram's job in launchd's system domain (macOS). */
export interface RootDaemon {
  pid: number;
  job: SystemJob | null;
}

/**
 * The daemon running as root for this user, when one runs: named in the
 * PID file (`inFile`, when the caller has looked), or run by the job a
 * sudo install loaded into launchd's system domain from the user's plist.
 * `job`: that job, when the caller has looked. Never on Windows, which has
 * no root, and where looking means asking PowerShell.
 */
export function findRootDaemon(
  inFile?: { pid: number; root: boolean } | null,
  job?: SystemJob | null,
): RootDaemon | null {
  if (process.platform === "win32") return null;
  try {
    const loaded = job === undefined ? systemJob() : job;
    const pid = rootDaemonPid(inFile === undefined ? daemonInPidFile() : inFile, loaded);
    return pid === null ? null : { pid, job: loaded };
  } catch {
    // Never what stops start, stop or status.
    return null;
  }
}

/**
 * How to stop it. Through launchd when its job runs it: KeepAlive starts
 * a daemon again after a crash, and unloading the job stops it for good.
 */
export function rootStopCommand(root: RootDaemon): string {
  return root.job?.pid === root.pid ? SYSTEM_JOB_UNLOAD : `sudo kill ${root.pid}`;
}

/** What to say of it: the problem, then what to run, in order. */
export function rootDaemonLines(root: RootDaemon): { problem: string; fixes: string[] } {
  const fixes = [`Stop it with: ${rootStopCommand(root)}`];
  // Loaded, and running another daemon or none: it would run one again.
  if (root.job !== null && root.job.pid !== root.pid) {
    fixes.push(`Also unload the job 'sudo engram install' loaded into launchd's system domain: ${SYSTEM_JOB_UNLOAD}`);
  }
  return { problem: `A daemon started with sudo is still running as root (pid ${root.pid}).`, fixes };
}

/**
 * Engram's job in launchd's system domain, loaded and running no daemon of
 * the user's: KeepAlive or a kickstart would start one as root. Gone at the
 * next restart: the system domain loads only /Library/LaunchDaemons.
 */
export function systemJobLeft(): string {
  return `The job 'sudo engram install' loaded into launchd's system domain is still there, and would run the daemon as root. Unload it with: ${SYSTEM_JOB_UNLOAD}`;
}

/**
 * Workers running as root that neither the PID file nor launchd ties to
 * this user, besides `known`: only said, never acted on. On macOS, where
 * the daemon never runs as root, any. On Linux only when ~/.engram has
 * files root owns, the mark of one in it: a daemon root runs for itself,
 * in its own home, is no concern of the user's.
 */
export function untiedRootWorkers(known: readonly (number | null)[], foreign: ForeignFiles | null): number[] {
  if (process.platform === "linux" && !foreign?.root) return [];
  try {
    return rootWorkerPids().filter((pid) => !known.includes(pid));
  } catch {
    return [];
  }
}

/** What to say of untied root workers: one line, with the command that stops them. */
export function untiedRootLine(pids: readonly number[]): string {
  const list = pids.join(" ");
  return pids.length === 1
    ? `A daemon is running as root (pid ${list}), most likely started with sudo. Stop it with: sudo kill ${list}`
    : `Daemons are running as root (pids ${pids.join(", ")}), most likely started with sudo. Stop them with: sudo kill ${list}`;
}
