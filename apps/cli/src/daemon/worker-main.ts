/**
 * Daemon worker body. Entry is worker.ts, which preflights the native
 * sqlite module (and self-heals ABI mismatches) before importing this —
 * keep any new native-module imports behind that boundary.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { Engram } from "@getengram/sdk";
import { loadConfigStrict, resolveBaseUrl } from "../config.js";
import { DaemonDb } from "./db.js";
import { Pruner } from "./prune.js";
import { Watcher } from "./watcher.js";
import { Syncer, type CaptureControl, type KeySource } from "./syncer.js";
import { SecretScrubber, type VaultLike } from "./scrubber.js";
import { loadVaultKey } from "../commands/vault.js";
import { availableAdapters } from "./adapters.js";
import { configuredKey, ownedKeysAt } from "./key-source.js";
import { makeDirPrivateSync, type PrivateDirReport } from "../private-files.js";
import { START_FAILED_EXIT } from "./supervise.js";
import {
  claimDaemonLock,
  markReady,
  markStopping,
  releaseDaemonLock,
  setDisplacedHandler,
  setStopHandler,
} from "./instance.js";

const ENGRAM_DIR = join(homedir(), ".engram");
const DB_FILE = join(ENGRAM_DIR, "daemon.db");
const LOG_FILE = join(ENGRAM_DIR, "daemon.log");

/**
 * How long shutdown waits for a flush in progress, and then for the final
 * flush. launchd and systemd kill a job that takes much longer to exit,
 * and a kill in the middle of a send loses the record that it was sent.
 */
const SHUTDOWN_WAIT_MS = 7_000;

function log(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  process.stderr.write(line);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Settles when `p` settles, or after `ms`, whichever comes first. */
function within(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    p.then(done, done);
  });
}

/** What makeDirPrivateSync did at start, when it did anything. */
function logPrivacy(made: PrivateDirReport): void {
  const set: string[] = [];
  if (made.dir === "changed") set.push("the folder to 0700");
  if (made.changed.length > 0) set.push(`${made.changed.join(", ")} to 0600`);
  if (set.length > 0) log(`made ~/.engram private: set ${set.join(", and ")}`);
  if (made.dir === "not-ours") log("~/.engram belongs to another user: its permissions were left as they are");
  if (made.skipped.length > 0) {
    log(`left ${made.skipped.length} file(s) in ~/.engram readable by others (not yours, or the change failed): ${made.skipped.join(", ")}`);
  }
  if (made.removed.length > 0) log(`removed ${made.removed.length} temp file(s) left by an interrupted write`);
}

async function main(): Promise<void> {
  // One daemon per user (engram#612). worker.ts has claimed the lock
  // before its preflight, and this returns what that claim found. A
  // launchd plist from before 0.4.2 starts this file directly
  // (engram#469): for it, this is the claim. It writes the PID file.
  const claim = await claimDaemonLock({ log });
  if (claim.state === "taken") process.exit(claim.retry ? 1 : 0);
  // Asked to stop while it took the lock (engram#669).
  if (claim.state === "stopped") process.exit(0);

  // Everything the daemon creates is the user's alone (engram#627): the
  // queue of transcript text, the log and status.json. Set here, after
  // worker.ts's preflight, so an `npm rebuild` it runs keeps the usual
  // umask. Then what an older version left in ~/.engram is set to 0600 as
  // well.
  if (process.platform !== "win32") process.umask(0o077);
  const made = makeDirPrivateSync(ENGRAM_DIR);

  log(`daemon started (pid ${process.pid})`);
  log(`database: ${DB_FILE}`);
  logPrivacy(made);

  // A signal shuts down whatever has been set up by then, in order.
  let db: DaemonDb | null = null;
  let scrubber: SecretScrubber | null = null;
  let syncer: Syncer | null = null;
  let pruner: Pruner | null = null;
  let shuttingDown = false;

  const shutdown = async (options: { flush?: boolean } = {}): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("shutting down...");
    // From here a start finds this daemon stopping, and waits for it
    // rather than exiting beside it (engram#612).
    markStopping();
    // A pass in progress stops at its next step and doesn't touch the
    // database after this, so it can be closed below.
    pruner?.stop();
    if (syncer) {
      // Capture stops, and no new flush starts. A flush in progress
      // finishes first, so a send that went through is recorded as sent.
      syncer.stop();
      await within(syncer.idle(), SHUTDOWN_WAIT_MS);
      // Final flush — still scrubbed: the scrubber is stopped only after.
      // It sends only with the key still configured. Not when another
      // daemon has taken over: that one sends what is queued, and a flush
      // here at the same time could send a message twice.
      if (options.flush !== false) await within(syncer.flush(), SHUTDOWN_WAIT_MS);
    }
    scrubber?.stop();

    try {
      db?.close();
    } catch (err: unknown) {
      log(`closing the database failed: ${errorText(err)}`);
    }

    // The PID file and the socket go last: until now a start found this
    // daemon stopping.
    releaseDaemonLock();
    log("daemon stopped");
    process.exit(0);
  };

  // SIGTERM and SIGINT: `engram stop`, launchd, Ctrl-C in the foreground.
  setStopHandler(() => void shutdown());
  setDisplacedHandler(() => {
    log("another daemon has taken over; this one is stopping");
    void shutdown({ flush: false });
  });

  // The API key: ENGRAM_API_KEY, fixed for this process, else config.json.
  // No key is not an error (engram#595): the daemon starts signed out,
  // reads config.json every few seconds, and starts capturing as soon as
  // `engram auth login` saves a key. It used to exit, and launchd started
  // it again every 10 seconds, logging the same error each time.
  const envKey = process.env.ENGRAM_API_KEY || undefined;
  let configBaseUrl: string | undefined;
  let apiKey = envKey;
  try {
    const config = await loadConfigStrict();
    configBaseUrl = typeof config.baseUrl === "string" ? config.baseUrl : undefined;
    if (!apiKey) apiKey = await configuredKey();
  } catch (err: unknown) {
    log(`couldn't read ~/.engram/config.json (${errorText(err)}) — will keep trying`);
  }

  const baseUrl = resolveBaseUrl({ baseUrl: configBaseUrl });
  const connect = (key: string): Engram =>
    new Engram({
      apiKey: key,
      baseUrl,
      // Appends of large transcript batches do real work server-side (per-
      // message R2 writes, chunking, embedding, indexing) — the SDK's default
      // 30s timeout aborted them mid-flight and wedged the queue in a retry
      // loop. The daemon is a background process; it can afford to wait.
      timeout: 120_000,
    });

  db = new DaemonDb(DB_FILE);
  const queue = db;

  // Known-value secret scrubbing. Deliberately a SEPARATE client: giving the
  // syncing client a vault key would switch on the SDK's auto-vaulting of
  // every captured message (client.store → processContent), which is a
  // behaviour change in its own right. This one exists only to read the
  // vault so the scrubber can match exact values.
  const vaultKey = await loadVaultKey();
  let vaultFor: ((key: string) => VaultLike | null) | null = null;
  if (vaultKey) {
    vaultFor = (key) =>
      new Engram({
        apiKey: key,
        baseUrl,
        vault: { encryptionKey: vaultKey },
        timeout: 30_000,
      }).vault;
    scrubber = new SecretScrubber(apiKey ? vaultFor(apiKey) : null, vaultKey, log);
    scrubber.start();
    log("vault scrubber: on (exact-match redaction of named secrets and the vault key)");
  } else {
    log("vault scrubber: off (no vault key configured — only pattern redaction applies)");
  }
  const vaultScrubber = scrubber;

  // The syncer reads the configured key every few seconds (engram#587,
  // engram#594): `engram auth login` saves a new key without restarting
  // this process, and `engram auth logout` removes it. An ENGRAM_API_KEY
  // set for the daemon is fixed for its lifetime and is never replaced
  // from config.json.
  const keys: KeySource = {
    current: apiKey,
    read: async () => envKey ?? (await configuredKey()),
    connect: (key) => {
      if (vaultScrubber && vaultFor) {
        vaultScrubber.reconnect(vaultFor(key)).catch((err: unknown) => {
          log(`vault scrubber: reconnect failed (${errorText(err)})`);
        });
      }
      return connect(key);
    },
    // Signed out: nothing is captured or sent, so the vault read through
    // the last key isn't kept in memory. The next key's is read when it
    // signs in, and nothing is sent before that read.
    disconnect: () => {
      vaultScrubber?.reconnect(null).catch(() => {});
    },
    // Only key fingerprints go to the server (see ownedKeysAt).
    ownedKeys: ownedKeysAt(baseUrl),
  };

  const sync = new Syncer(queue, apiKey ? connect(apiKey) : null, vaultScrubber, keys);
  syncer = sync;

  // syncer.onMessages queues the messages before it returns, and throws
  // when it can't. That reaches the watcher, which holds the file at the
  // line and reads it again later (engram#584). The promise it returns
  // covers only the server-side delete an in-chat opt-out starts, which
  // retries on its own: a failure there is only logged.
  const onMessages: ConstructorParameters<typeof Watcher>[1] = (
    sessionId,
    meta,
    messages,
  ) => {
    sync.onMessages(sessionId, meta, messages).catch((err) => {
      log(`sync error: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  // One watcher per installed host (engram#261). Hosts that aren't
  // installed are skipped, so this is safe on any machine.
  const adapters = availableAdapters();
  if (adapters.length === 0) {
    log("no supported hosts detected (Claude Code, Codex). Nothing to watch.");
  }
  for (const a of adapters) log(`watching ${a.label}: ${a.watchDir}`);

  // Capture runs only while a key is configured (engram#594): the syncer
  // starts it at sign-in and stops it at a logout or a change of key, so
  // whatever is read is queued for the account signed in at the time.
  // Watchers are built fresh each time; each resumes from the offsets
  // daemon.db keeps.
  let watchers: Watcher[] = [];
  const capture: CaptureControl = {
    start: () => {
      watchers = adapters.map((a) => new Watcher(queue, onMessages, a));
      for (const w of watchers) {
        try {
          w.start();
        } catch (err: unknown) {
          log(`watching ${w.host} failed: ${errorText(err)}`);
        }
      }
    },
    stop: (drain) => {
      const stopping = watchers;
      watchers = [];
      for (const w of stopping) {
        try {
          w.stop({ drain });
        } catch (err: unknown) {
          log(`stopping the ${w.host} watcher failed: ${errorText(err)}`);
        }
      }
    },
  };

  log(
    envKey
      ? "API key: ENGRAM_API_KEY (fixed for this process; 'engram auth login' and 'logout' don't change it)"
      : "API key: ~/.engram/config.json (read again every few seconds)",
  );

  // Start
  sync.setCaptureControl(capture);
  sync.start();

  // Sent messages leave the local queue a while after the server has them
  // (engram#598); unsent ones never do.
  pruner = new Pruner(queue, DB_FILE, { log });
  pruner.start();

  log(`watching for transcripts across ${adapters.length} host(s)...`);
  // Last: `engram start` reports the daemon started once it answers as
  // ready, so everything above has run by then.
  markReady();
}

// main() has failed before it marked the daemon ready, so this is never one
// that `engram start` reported as started (engram#613; see supervise.ts).
main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(START_FAILED_EXIT);
});
