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

if (!ensureNativeSqlite(log)) {
  log("daemon exiting: native sqlite unavailable");
  process.exit(1);
}

await import("./worker-main.js");
