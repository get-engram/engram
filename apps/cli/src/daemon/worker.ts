#!/usr/bin/env node

/**
 * Daemon worker process. Spawned by `engram start` and runs detached.
 * Watches Claude Code transcripts and streams them to Engram.
 */

import { writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Engram } from "@getengram/sdk";
import { loadConfig, getBaseUrl } from "../config.js";
import { DaemonDb } from "./db.js";
import { Watcher } from "./watcher.js";
import { Syncer } from "./syncer.js";

const ENGRAM_DIR = join(homedir(), ".engram");
const PID_FILE = join(ENGRAM_DIR, "daemon.pid");
const DB_FILE = join(ENGRAM_DIR, "daemon.db");
const LOG_FILE = join(ENGRAM_DIR, "daemon.log");
const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

function log(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  process.stderr.write(line);
}

async function main(): Promise<void> {
  // Write PID file
  writeFileSync(PID_FILE, String(process.pid));

  log(`daemon started (pid ${process.pid})`);
  log(`watching: ${CLAUDE_PROJECTS_DIR}`);
  log(`database: ${DB_FILE}`);

  // Load API key
  const config = await loadConfig();
  const apiKey = process.env.ENGRAM_API_KEY ?? config.apiKey;
  if (!apiKey) {
    log("ERROR: no API key. Run 'engram auth login' first.");
    process.exit(1);
  }

  const client = new Engram({
    apiKey,
    baseUrl: process.env.ENGRAM_BASE_URL ?? config.baseUrl ?? getBaseUrl(),
  });

  const db = new DaemonDb(DB_FILE);

  const syncer = new Syncer(db, client);

  // Wrap syncer.onMessages to handle the async call
  const onMessages: ConstructorParameters<typeof Watcher>[1] = (
    sessionId,
    meta,
    messages,
  ) => {
    syncer.onMessages(sessionId, meta, messages).catch((err) => {
      log(`sync error: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  const watcher = new Watcher(db, onMessages, CLAUDE_PROJECTS_DIR);

  // Start
  watcher.start();
  syncer.startFlushLoop();

  log("watching for transcripts...");

  // Graceful shutdown
  const shutdown = async () => {
    log("shutting down...");
    watcher.stop();
    syncer.stopFlushLoop();

    // Final flush
    try {
      await syncer.flush();
    } catch {
      // best effort
    }

    db.close();

    try {
      unlinkSync(PID_FILE);
    } catch {
      // already gone
    }

    log("daemon stopped");
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
