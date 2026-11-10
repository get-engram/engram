/**
 * Daemon worker body. Entry is worker.ts, which preflights the native
 * sqlite module (and self-heals ABI mismatches) before importing this —
 * keep any new native-module imports behind that boundary.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { Engram } from "@getengram/sdk";
import { ConfigUnreadable } from "../config-file.js";
import { DaemonDb } from "./db.js";
import { Pruner } from "./prune.js";
import { Watcher } from "./watcher.js";
import { Syncer, type Account, type CaptureControl, type KeySource } from "./syncer.js";
import { SecretScrubber, type VaultKeySource, type VaultLike } from "./scrubber.js";
import { asVaultKeyProblem, readVaultKey, vaultKeyFix, type VaultKeyUnreadable } from "../vault-key.js";
import { availableAdapters } from "./adapters.js";
import { configuredAccount, ownedKeysOf } from "./key-source.js";
import { makeDirPrivateSync, type PrivateDirReport } from "../private-files.js";
import { START_FAILED_EXIT } from "./supervise.js";
import { foreignFiles, foreignFilesFix, foreignFilesProblem, OWNERSHIP_FIX } from "./ownership.js";
import { notifyDesktopBeforeExit, recordVaultKey } from "./status.js";
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

  // Files in ~/.engram that are root's, from `sudo engram …` (engram#659).
  // The daemon can't run with some of them (stopsDaemon). It used to fail
  // on the first, exit with an error, and be started again every few
  // seconds, for good. Now it says which, and how to make them the user's,
  // and exits cleanly, which launchd and systemd leave stopped. The rest
  // only warn.
  const foreign = foreignFiles();
  if (foreign?.stopsDaemon) {
    log(`daemon exiting: ${foreignFilesProblem(foreign, "stopped")}`);
    log(foreignFilesFix(foreign));
    log("Then run: engram start");
    // The log may be one of them, and nobody reads it: this reaches the user.
    await notifyDesktopBeforeExit(
      "Engram capture has stopped",
      `Files in ~/.engram belong to ${foreign.root ? "root" : "another user"}, not to you. To fix it, run: ${OWNERSHIP_FIX}`,
    );
    process.exit(0);
  }
  if (foreign) log(`warning: ${foreignFilesProblem(foreign, "running")} ${foreignFilesFix(foreign)}`);
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

  // The account: the API key and its server, read together (engram#685) —
  // ENGRAM_API_KEY and ENGRAM_BASE_URL, fixed for this process, else
  // config.json. No key is not an error (engram#595): the daemon starts
  // signed out, reads config.json every few seconds, and starts capturing
  // as soon as `engram auth login` saves a key. It used to exit, and
  // launchd started it again every 10 seconds, logging the same error each
  // time. A config.json that can't be read is neither no key nor the
  // default server: nothing is captured or sent until it has been read.
  const envKey = process.env.ENGRAM_API_KEY || undefined;
  let current: Account | undefined;
  let unread = false;
  try {
    current = await configuredAccount();
  } catch (err: unknown) {
    unread = true;
    // Never the file's text, which holds the key (engram#673).
    log(
      `${err instanceof ConfigUnreadable ? err.message : `couldn't read ~/.engram/config.json (${errorText(err)})`}` +
        " — nothing is captured or sent until it can be read; will keep trying",
    );
  }

  const connect = (account: Account): Engram =>
    new Engram({
      apiKey: account.key,
      baseUrl: account.server,
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
  //
  // Only a key file that isn't there means no key (engram#677). One that
  // can't be read holds sends until it can be: the scrubber reads it again,
  // and captures keep queueing meanwhile. Never the key in a log line.
  //
  // The scrubber reads the key again before each send, and on its interval
  // (engram#693): a key saved, or put in place of another, while this runs
  // is used from the next send on, without a restart. So there is one even
  // with no key yet.
  let vaultKey: string | undefined;
  let keyProblem: VaultKeyUnreadable | undefined;
  try {
    vaultKey = await readVaultKey();
  } catch (err: unknown) {
    keyProblem = asVaultKeyProblem(err);
  }
  // Where the key in use came from, for `engram status`: a key file deleted
  // since leaves it in use until a restart.
  const keyOrigin = (): "env" | "file" => (process.env.ENGRAM_VAULT_KEY ? "env" : "file");
  recordVaultKey(vaultKey ? keyOrigin() : null);
  // The account in use, for the vault read with a key found later.
  let account: Account | undefined = current;
  const vaultFor = (a: Account | undefined, key = vaultKey): VaultLike | null =>
    a && key
      ? new Engram({
          apiKey: a.key,
          baseUrl: a.server,
          vault: { encryptionKey: key },
          timeout: 30_000,
        }).vault
      : null;
  const keySource: VaultKeySource = {
    read: readVaultKey,
    // The key the vault is read with from now on, after an account switch
    // too.
    vaultWith: (key) => {
      const vault = vaultFor(account, key);
      vaultKey = key;
      recordVaultKey(keyOrigin());
      return vault;
    },
  };
  const vaultScrubber = new SecretScrubber(vaultFor(current), vaultKey, log, {
    source: keySource,
    problem: keyProblem,
  });
  scrubber = vaultScrubber;
  vaultScrubber.start();
  if (vaultKey) {
    log("vault scrubber: on (exact-match redaction of named secrets and the vault key)");
  } else if (keyProblem) {
    log(
      `vault scrubber: holding sends — ${keyProblem.message}. Capture goes on, and what it ` +
        `captures is sent once the key can be read. ${vaultKeyFix(keyProblem)}`,
    );
  } else {
    log(
      "vault scrubber: off until a vault key is saved (no vault key configured — only pattern " +
        "redaction applies)",
    );
  }

  // The syncer reads the configured account every few seconds (engram#587,
  // engram#594, engram#685): `engram auth login` saves a new key without
  // restarting this process, `engram auth logout` removes it, and a new
  // baseUrl in config.json is a new account like a new key is. An
  // ENGRAM_API_KEY or ENGRAM_BASE_URL set for the daemon is fixed for its
  // lifetime and is never replaced from config.json.
  const keys: KeySource = {
    current,
    unread,
    read: configuredAccount,
    connect: (next) => {
      account = next;
      vaultScrubber.reconnect(vaultFor(next)).catch((err: unknown) => {
        log(`vault scrubber: reconnect failed (${errorText(err)})`);
      });
      return connect(next);
    },
    // Signed out: nothing is captured or sent, so the vault read through
    // the last key isn't kept in memory. The next key's is read when it
    // signs in, and nothing is sent before that read.
    disconnect: () => {
      account = undefined;
      vaultScrubber.reconnect(null).catch(() => {});
    },
    // Only key fingerprints go to the server, and only to the account's
    // own (see ownedKeysAt).
    ownedKeys: ownedKeysOf(),
  };

  const sync = new Syncer(queue, current ? connect(current) : null, vaultScrubber, keys);
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
  // Never the address itself, which can carry credentials.
  log(
    process.env.ENGRAM_BASE_URL?.trim()
      ? "server: ENGRAM_BASE_URL (fixed for this process)"
      : "server: baseUrl in ~/.engram/config.json, else the default (read with the key)",
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
