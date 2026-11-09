#!/usr/bin/env node

/**
 * The Windows daemon's supervisor (engram#613): `engram start` and the
 * sign-in entry (login-start.ts) run this, detached and hidden, and it runs
 * the worker. What it does is in supervise.ts; this is the processes and
 * files it does it with.
 *
 * `--report-until=<ms since the epoch>`: `engram start` waits on the first
 * worker until then (see supervise.ts).
 *
 * It logs to the daemon's log, as "supervisor: …". It reads the stop file
 * and the daemon's answer, and never config.json: it has no use for the
 * API key.
 *
 * Import-light, like worker.ts: see launch.ts.
 */

import { probeDaemon, readStopFile, removeStopFileIf } from "./instance.js";
import { spawnWorker } from "./launch.js";
import { reportUntilArg, supervise } from "./supervise.js";

function log(msg: string): void {
  process.stderr.write(`[${new Date().toISOString()}] supervisor: ${msg}\n`);
}

/** Start a worker, and resolve to its exit code once it exits. */
function start(): Promise<number | null> {
  const child = spawnWorker();
  // spawnWorker lets the process that started it exit first; this one waits.
  child.ref();
  return new Promise((resolve) => {
    child.once("exit", (code: number | null) => resolve(code));
    child.once("error", (err: Error) => {
      log(`couldn't start the daemon: ${err.message}`);
      resolve(null);
    });
  });
}

try {
  const code = await supervise(
    {
      start,
      running: async () => {
        const probe = await probeDaemon({ timeoutMs: 1_000 });
        return probe.state === "answered" && !probe.info.stopping;
      },
      stopStamp: () => readStopFile()?.stamp ?? null,
      removeStop: (stamp) => removeStopFileIf((request) => request.stamp === stamp),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      log,
    },
    { reportUntil: reportUntilArg(process.argv.slice(2)) },
  );
  process.exit(code);
} catch (err) {
  log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
}
