#!/usr/bin/env node

/**
 * Daemon entry point. Spawned by `engram start` and runs detached.
 *
 * This file must stay import-light: it preflights better-sqlite3 (healing
 * the ABI mismatch that occurs when the installing Node differs from the
 * running Node) BEFORE the worker body — with its static sqlite imports —
 * is loaded. A static import here would defeat the preflight.
 */

import { claimDaemonLock } from "./instance.js";
import { ensureNativeSqlite } from "./preflight.js";
import { START_FAILED_EXIT } from "./supervise.js";

function log(msg: string): void {
  process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`);
}

// One daemon per user (engram#612): if one is running already, this one
// exits now. First, before the preflight, so two starts at once never run
// `npm rebuild` side by side either. The claim logs what it found. Exit 0
// when another daemon has the lock, so launchd, which restarts the worker
// only after a failure, leaves it at that; 1 when it couldn't be told.
const claim = await claimDaemonLock({ log });
if (claim.state === "taken") process.exit(claim.retry ? 1 : 0);
// Asked to stop while it took the lock: a clean exit, which launchd leaves stopped (engram#669).
if (claim.state === "stopped") process.exit(0);

// START_FAILED_EXIT, as for every failure before it is ready (engram#613):
// the Windows supervisor then lets `engram start` report it. launchd starts
// it again after any error exit, as it did after 1.
if (!ensureNativeSqlite(log)) {
  log("daemon exiting: native sqlite unavailable");
  process.exit(START_FAILED_EXIT);
}

await import("./worker-main.js");
