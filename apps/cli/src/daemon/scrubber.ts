/**
 * Value-exact secret scrubbing for captured transcripts.
 *
 * The problem this solves is structural, not a missing regex. Pattern-based
 * redaction (services/conversation.ts → redact()) catches credentials that
 * have a shape — sk_live_…, postgres://…, PEM blocks. It cannot catch the
 * secrets people actually keep in a vault: a password, a passphrase, a PIN,
 * a licence key, a recovery phrase. Measured on the shipped redactor, 12 of
 * 17 realistic vault contents passed through verbatim. A four-digit PIN is
 * indistinguishable from any other number; no pattern can fix that without
 * destroying the memory it is meant to protect.
 *
 * Zero-knowledge makes it worse for the server specifically: it holds no
 * plaintext vault values, so it can never build an exact denylist. Only the
 * client can — the vault key lives here, and `engram vault get` decrypts on
 * this machine every day. So this is where the exact match belongs.
 *
 * What it does: holds the plaintext of every named vault secret (and the
 * vault key itself) in memory, and replaces exact occurrences in captured
 * message content with `[VAULT:name]`: when a message is queued, and again
 * when it is sent. That is the same token form the SDK's resolveSecrets
 * understands, so a recalled memory still reads coherently and can still be
 * resolved by a client with the key.
 *
 * Why twice (engram#588): a message can be queued before the vault has been
 * read. Everything the watcher's first scan finds at start is, and so is
 * anything captured while a read fails or while a replaced key's first read
 * is in flight. Queueing can't wait for the read (the watcher's offset
 * bookkeeping needs it synchronous, engram#370), so sending does: the syncer
 * sends nothing until ready(), and scrubs each batch again against the set
 * held at that moment. A token holds no value, so the second pass changes
 * nothing else.
 *
 * ready() is true once a read through the current client has completed, or
 * has failed in a way waiting can't fix: the server's own refusal, such as a
 * key without the read scope. A failure that may pass is retried within
 * seconds (READ_RETRY_MS), and sends wait:
 *  - until a read goes through, when the server couldn't be reached — the
 *    sends couldn't have gone out either;
 *  - for at most MAX_SERVER_HOLD_MS while the server answers with errors
 *    (an attempt that can't reach it starts that count again). Then sends
 *    resume with the secrets already known, so a broken vault endpoint
 *    can't stop capture, and the interval keeps reading.
 *
 * A vault key that is there but can't be read (engram#677) — a file of
 * mode 000, a folder in its place, a link to nothing, an empty file —
 * leaves nothing to read the vault with, nor to scrub its secrets with. It
 * used to count as no key, and every secret went out as it was. Now sends
 * wait for as long as it lasts: no bound releases them, since nothing
 * would make them safe to send. Captures keep queueing meanwhile. The key
 * is read again on READ_RETRY_MS; once it reads, the vault is read through
 * it, and sends wait for that read like any other. A key file gone by then
 * holds them still: it is likely being put back, and sending in between
 * would send what the key protects. A restart starts without a key.
 *
 * What it never does: write a value to disk, include one in a log line, or
 * send one anywhere. Values are refreshed from the vault on an interval and
 * dropped on stop. The daemon already runs as the user who owns the 0600
 * key file and already holds the API key; this adds no new trust boundary,
 * only closes a leak inside the existing one.
 */

import { isRefusal } from "./status.js";
import { asVaultKeyProblem, VaultKeyUnreadable } from "../vault-key.js";

export interface VaultLike {
  list(): Promise<Array<{ name: string }>>;
  get(name: string): Promise<string | null>;
}

/**
 * Where the key is read again while it can't be (engram#677). read():
 * the key, undefined when the file isn't there, and throws when it can't
 * be read. vaultWith(): the vault, read with that key, of the account in
 * use now; null when signed out.
 */
export interface VaultKeySource {
  read(): Promise<string | undefined>;
  vaultWith(key: string): VaultLike | null;
}

export interface ScrubResult {
  text: string;
  /** Number of replacements made. Names only — never the values. */
  replaced: Array<{ name: string; count: number }>;
}

/** Values shorter than this are not scrubbed: too likely to be coincidence. */
export const MIN_SCRUB_LENGTH = 4;

/** After a read that may pass: retry in 10s → 30s → 1min → 1min … */
export const READ_RETRY_MS = [10_000, 30_000, 60_000];

/** The longest sends wait while the server answers but the vault won't read. */
export const MAX_SERVER_HOLD_MS = 15 * 60_000;

/**
 * How a vault request failed, and so whether waiting can help:
 *  - refused: the server's own refusal, repeated however long we wait;
 *  - network: no answer at all — offline, DNS, timed out;
 *  - server: an answer that was an error — a 5xx, a rate limit, a rejected
 *    key — or a reply that isn't the JSON a vault reply is;
 *  - local: not the request — a value that doesn't decrypt with this vault key.
 */
type Failure = "refused" | "network" | "server" | "local";

/** What the SDK throws for a request that failed. */
const REQUEST_ERRORS = new Set(["EngramError", "AuthenticationError", "NotFoundError", "TimeoutError"]);

function failureOf(err: unknown): Failure {
  if (isRefusal(err)) return "refused";
  const name = errorName(err);
  if (name === "TimeoutError" || errorText(err).startsWith("Network error:")) return "network";
  return REQUEST_ERRORS.has(name) || name === "SyntaxError" ? "server" : "local";
}

function errorName(err: unknown): string {
  const name = err !== null && typeof err === "object" ? (err as { name?: unknown }).name : undefined;
  return typeof name === "string" ? name : "";
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface Read {
  vault: VaultLike | null;
  done: Promise<void>;
}

export class SecretScrubber {
  /** name → plaintext. The only place plaintext lives, and only in memory. */
  private values = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  /** The read in flight, and the client it goes through. */
  private reading: Read | null = null;
  /**
   * The client the set was read through in full, or that can't read the
   * vault at all. Compared by identity: a replaced client isn't ready until
   * a read through it settles.
   */
  private settledFor: VaultLike | null | undefined = undefined;
  /** Why the last read through the current client fell short. */
  private lastFailure: unknown = undefined;
  private retryAt = 0;
  private retryStep = 0;
  /** Since when reads have failed with an answer from the server; 0 if not. */
  private serverFailingSince = 0;
  /** The hold outlasted MAX_SERVER_HOLD_MS: sends go with what's known. */
  private released = false;
  private refusalLogged = false;
  private undecryptable = 0;

  /** Why the vault key can't be read, while sends wait for it (engram#677). */
  private keyProblem: VaultKeyUnreadable | undefined = undefined;
  private keySource: VaultKeySource | undefined = undefined;
  private keyRetryAt = 0;
  private keyRetryStep = 0;
  /** The read of the key in flight. */
  private keyRead: Promise<void> | null = null;

  /**
   * `pendingKey`: the vault key couldn't be read at start, so sends wait
   * until it can be, from `source` (engram#677). `vault` is null then, and
   * `vaultKey` undefined.
   */
  constructor(
    private vault: VaultLike | null,
    private vaultKey: string | undefined,
    private readonly log: (msg: string) => void = () => {},
    pendingKey?: { problem: unknown; source: VaultKeySource },
  ) {
    // Known before any read: scrubbed from the first message queued.
    if (vaultKey && vaultKey.length >= MIN_SCRUB_LENGTH) this.values.set("vault-key", vaultKey);
    if (pendingKey) {
      this.keyProblem = asVaultKeyProblem(pendingKey.problem);
      this.keySource = pendingKey.source;
      // It was read just now.
      this.keyRetryAt = Date.now() + READ_RETRY_MS[0];
      this.keyRetryStep = 1;
    }
  }

  /** True when there is anything to scrub against. */
  get active(): boolean {
    return this.values.size > 0;
  }

  /** Names currently loaded. Safe to log. */
  get names(): string[] {
    return [...this.values.keys()];
  }

  /** Why the vault couldn't be read through the current client, while
   *  ready() is false: a VaultKeyUnreadable while the key can't be read. */
  get failure(): unknown {
    return this.keyProblem ?? this.lastFailure;
  }

  /**
   * Read every secret's plaintext. A call while a read through the same
   * client is in flight joins it. Failures are non-fatal and never shrink
   * the set: a secret that can't be read keeps the value already known for
   * it, so a transient error can never turn scrubbing off silently in the
   * middle of a session.
   */
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const vault = this.vault;
    if (this.reading && this.reading.vault === vault) return this.reading.done;
    const read: Read = { vault, done: Promise.resolve() };
    read.done = this.read(vault)
      .catch((err: unknown) => {
        this.fellShort(vault, err, "server");
        this.log(`vault scrubber: read failed (${errorText(err)})`);
      })
      .catch(() => {}) // a log that throws: ready() mustn't
      .finally(() => {
        if (this.reading === read) this.reading = null;
      });
    this.reading = read;
    return read.done;
  }

  /**
   * Whether captured messages may be sent now (engram#588). True once the
   * set covers the vault, or the vault can't be read with this key at all,
   * or the server has failed the read for MAX_SERVER_HOLD_MS. Until then it
   * waits for a read through the current client that is in flight, and
   * retries a failed one when its retry is due — at the bound too, so the
   * hold isn't released on an answer that's out of date.
   *
   * A set already read in full doesn't wait for the periodic re-read: that
   * only refreshes it. A released hold doesn't retry either: the interval
   * reads, and the flush loop doesn't add a read every few seconds.
   *
   * Before any of it, a vault key that can't be read is read again when its
   * retry is due (engram#677). Until it reads, ready() is false, however
   * long that takes.
   */
  async ready(): Promise<boolean> {
    if (this.stopped) return false;
    if (this.keyProblem !== undefined) {
      if (Date.now() < this.keyRetryAt) return false;
      await this.retryKey();
      if (this.stopped || this.keyProblem !== undefined) return false;
    }
    if (this.settled()) return true;
    await this.inFlight();
    if (this.settled()) return true;
    if (this.released) return true;

    if (Date.now() >= this.retryAt) {
      await this.refresh();
      await this.inFlight();
      if (this.settled()) return true;
    }
    if (!this.pastBound()) return false;
    this.released = true;
    this.log(
      `vault scrubber: the vault has failed to read for ${MAX_SERVER_HOLD_MS / 60_000} minutes — ` +
        `sending with the ${this.values.size} secret(s) already known, and still retrying ` +
        `(${errorText(this.lastFailure)})`,
    );
    return true;
  }

  /**
   * Read the vault through a new client: the daemon's API key was replaced
   * (engram#587). Reads at once, and ready() waits for that read. Until it
   * settles, the current set stays in force, and a read that fails keeps it
   * too.
   */
  reconnect(vault: VaultLike | null): Promise<void> {
    this.vault = vault;
    this.settledFor = undefined;
    this.lastFailure = undefined;
    this.retryAt = 0;
    this.retryStep = 0;
    this.serverFailingSince = 0;
    this.released = false;
    this.refusalLogged = false;
    return this.refresh();
  }

  /** Read now and on an interval. */
  start(intervalMs = 10 * 60_000): void {
    this.stopped = false;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Drop plaintext the moment it is no longer needed. A read still in
    // flight finds the scrubber stopped and keeps nothing.
    this.values.clear();
    this.settledFor = undefined;
    this.serverFailingSince = 0;
    this.released = false;
  }

  /**
   * Replace every exact occurrence of a known secret with its token.
   * Longest values first, so a secret that contains another secret is
   * replaced whole rather than leaving a readable fragment behind.
   */
  scrub(text: string): ScrubResult {
    if (!text || this.values.size === 0) return { text, replaced: [] };

    const ordered = [...this.values.entries()].sort((a, b) => b[1].length - a[1].length);
    let out = text;
    const replaced: Array<{ name: string; count: number }> = [];

    for (const [name, value] of ordered) {
      let count = 0;
      let idx = out.indexOf(value);
      if (idx === -1) continue;
      const token = `[VAULT:${name}]`;
      while (idx !== -1) {
        out = out.slice(0, idx) + token + out.slice(idx + value.length);
        count++;
        idx = out.indexOf(value, idx + token.length);
      }
      replaced.push({ name, count });
    }
    return { text: out, replaced };
  }

  /** Read the key again: one read at a time. */
  private retryKey(): Promise<void> {
    this.keyRead ??= this.readKey()
      // A log that throws: the hold stays until it has been lifted in full,
      // and ready() mustn't throw.
      .catch(() => {})
      .finally(() => {
        this.keyRead = null;
      });
    return this.keyRead;
  }

  /**
   * The key still can't be read: try again on READ_RETRY_MS. It isn't
   * there: still wait, for the key put back or a restart. It reads: scrub
   * it from now on, and read the vault with it, which sends wait for.
   */
  private async readKey(): Promise<void> {
    const source = this.keySource;
    if (source === undefined) return;
    // The next try, should this one fall short in any way.
    this.keyRetryAt = Date.now() + READ_RETRY_MS[Math.min(this.keyRetryStep, READ_RETRY_MS.length - 1)];
    this.keyRetryStep++;
    let read: { key: string } | { problem: VaultKeyUnreadable };
    try {
      const key = await source.read();
      read = key === undefined ? { problem: new VaultKeyUnreadable("isn't there any more", "gone") } : { key };
    } catch (err: unknown) {
      read = { problem: asVaultKeyProblem(err) };
    }
    if (this.stopped) return;

    if ("problem" in read) {
      const { problem } = read;
      const changed = problem.message !== this.keyProblem?.message;
      this.keyProblem = problem;
      if (changed) this.log(`vault scrubber: still holding sends — ${problem.message}`);
      return;
    }

    const { key } = read;
    const vault = source.vaultWith(key);
    this.vaultKey = key;
    if (key.length >= MIN_SCRUB_LENGTH) this.values.set("vault-key", key);
    // Lifted, and at once the read through `vault` starts: ready() waits
    // for that read, as after any new client.
    this.keyProblem = undefined;
    this.keySource = undefined;
    const done = this.reconnect(vault);
    this.log("vault scrubber: the vault key can be read now — reading the vault before sending what was held");
    await done;
  }

  private settled(): boolean {
    return !this.stopped && this.settledFor === this.vault;
  }

  /** Wait for reads through the current client, including one a reconnect
   *  starts meanwhile. */
  private async inFlight(): Promise<void> {
    while (this.reading && this.reading.vault === this.vault) await this.reading.done;
  }

  /**
   * A read through `vault` fell short of the vault: not ready, and retry on
   * READ_RETRY_MS. Only the server's answers count toward the bound — while
   * it can't be reached, nothing can be sent anyway, and a set cut short by
   * an outage mustn't go out the moment the network returns.
   */
  private fellShort(vault: VaultLike | null, err: unknown, failure: "network" | "server"): void {
    if (this.stopped || vault !== this.vault) return;
    this.settledFor = undefined;
    this.lastFailure = err;
    this.retryAt = Date.now() + READ_RETRY_MS[Math.min(this.retryStep, READ_RETRY_MS.length - 1)];
    this.retryStep++;
    if (failure === "network") {
      this.serverFailingSince = 0;
      this.released = false;
    } else if (this.serverFailingSince === 0) {
      this.serverFailingSince = Date.now();
    }
  }

  /** The server has failed the read for MAX_SERVER_HOLD_MS. */
  private pastBound(): boolean {
    return (
      !this.stopped &&
      this.serverFailingSince !== 0 &&
      Date.now() - this.serverFailingSince >= MAX_SERVER_HOLD_MS
    );
  }

  private async read(vault: VaultLike | null): Promise<void> {
    const next = new Map<string, string>();

    // The key itself is the most damaging thing to leak, and `engram vault
    // keygen` without --save prints it to the terminal.
    if (this.vaultKey && this.vaultKey.length >= MIN_SCRUB_LENGTH) {
      next.set("vault-key", this.vaultKey);
    }

    // A periodic re-read of a set already read in full through this client:
    // a secret it fails to read keeps its value from that set, which stays
    // complete.
    const rereading = this.settledFor === vault;
    // The failure that leaves this read short of the vault, if any.
    let short: { err: unknown; failure: "network" | "server" } | null = null;
    let refused: unknown = undefined;
    let undecryptable = 0;

    if (vault) {
      let entries: Array<{ name: string }> = [];
      try {
        entries = await vault.list();
      } catch (err) {
        const failure = failureOf(err);
        if (failure === "refused") {
          refused = err;
        } else {
          this.log(
            `vault scrubber: reading the vault failed, keeping the ${this.values.size} secret(s) ` +
              `already known (${errorText(err)})`,
          );
          // A list that didn't come back is a gap of unknown size.
          if (!rereading) short = { err, failure: failure === "network" ? "network" : "server" };
        }
        // Nothing was read: every secret already known stays in force.
        for (const [name, value] of this.values) next.set(name, value);
      }

      // After a request that got no answer, the rest would only wait out the
      // same timeout.
      let unreachable: { err: unknown } | null = null;
      for (const { name } of entries) {
        let err: unknown;
        if (unreachable) {
          err = unreachable.err;
        } else {
          try {
            const value = await vault.get(name);
            if (value && value.length >= MIN_SCRUB_LENGTH) next.set(name, value);
            continue;
          } catch (e) {
            err = e;
          }
        }
        // One unreadable secret must not block the rest, nor drop the value
        // already known for it (engram#588).
        const previous = this.values.get(name);
        if (previous !== undefined) next.set(name, previous);
        const failure = failureOf(err);
        if (failure === "refused") {
          refused ??= err;
          continue;
        }
        if (failure === "local") {
          undecryptable++;
          continue;
        }
        if (failure === "network") unreachable = { err };
        if (!(rereading && previous !== undefined) && (short === null || failure === "network")) {
          short = { err, failure };
        }
      }
    }

    // The client was replaced mid-read (the API key changed): this set is
    // the old client's, and the read through the new one decides. Applying
    // it could put an account's secrets in place of the current one's after
    // the current one had loaded. A stopped scrubber keeps nothing.
    if (this.stopped || vault !== this.vault) return;

    const before = this.values.size;
    this.values = next;
    if (next.size !== before) {
      this.log(`vault scrubber: protecting ${next.size} secret(s)`);
    }
    if (undecryptable !== this.undecryptable) {
      this.undecryptable = undecryptable;
      if (undecryptable > 0) {
        this.log(
          `vault scrubber: ${undecryptable} secret(s) don't decrypt with this vault key, ` +
            `so they can't be scrubbed`,
        );
      }
    }

    if (short) {
      this.fellShort(vault, short.err, short.failure);
      return;
    }

    this.settledFor = vault;
    this.lastFailure = undefined;
    this.retryAt = 0;
    this.retryStep = 0;
    this.serverFailingSince = 0;
    this.released = false;
    if (refused !== undefined && !this.refusalLogged) {
      this.refusalLogged = true;
      this.log(
        `vault scrubber: this API key can't read the vault — scrubbing only the ${next.size} ` +
          `secret(s) already known (${errorText(refused)})`,
      );
    }
  }
}
