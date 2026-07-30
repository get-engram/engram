#!/usr/bin/env node

/**
 * Daemon entry point. Spawned by `engram start` and runs detached.
 *
 * This file must stay import-light: it preflights better-sqlite3 (healing
 * the ABI mismatch that occurs when the installing Node differs from the
 * running Node) BEFORE the worker body — with its static sqlite imports —
 * is loaded. A static import here would defeat the preflight.
 */

import { ensureNativeSqlite } from "./preflight.js";

function log(msg: string): void {
  process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`);
}

if (!ensureNativeSqlite(log)) {
  log("daemon exiting: native sqlite unavailable");
  process.exit(1);
}

await import("./worker-main.js");
