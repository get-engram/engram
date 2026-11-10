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
 * The key is read again before each send, and on the interval (engram#693).
 * It used to be read only at start: a key saved while the daemon ran went
 * unused until a restart, and the secrets of the vault it opens went out as
 * they were meanwhile. Now a key saved, or put in place of another, is used
 * from the next send on: the vault is read through it first, and sends wait
 * for that read, as at a start with a key. A key it replaced is scrubbed
 * still, as is each way a key may be written. A key file deleted while its
 * key is in use leaves that key in use, with the secrets read through it: a
 * restart starts without it, and `engram status` says so. A key file that
 * can't be read any more holds sends, as at start: the key in it may not be
 * the one in use.
 *
 * What it never does: write a value to disk, include one in a log line, or
 * send one anywhere. Values are refreshed from the vault on an interval and
 * dropped on stop. The daemon already runs as the user who owns the 0600
 * key file and already holds the API key; this adds no new trust boundary,
 * only closes a leak inside the existing one.
 */

import { isRefusal } from "./status.js";
import { asVaultKeyProblem, sameVaultKey, vaultKeySpellings, VaultKeyUnreadable } from "../vault-key.js";

export interface VaultLike {
  list(): Promise<Array<{ name: string }>>;
  get(name: string): Promise<string | null>;
}

/**
 * Where the key is read again (engram#677, engram#693). read(): the key,
 * undefined when the file isn't there, and throws when it can't be read.
 * vaultWith(): the vault, read with that key, of the account in use now;
 * null when signed out. From then on, the key is the one the vault is read
 * with, after an account switch too.
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

  /** The vault key in use, trimmed: the one the vault is read with. */
  private vaultKey: string | undefined = undefined;
  /**
   * Each way the key in use, and each key before it, may be written
   * (engram#693): scrubbed as "vault-key" along with the set. Only in
   * memory, like the set, and dropped on stop.
   */
  private keyForms: string[] = [];
  /** Where the key is read again: before each send, and on the interval. */
  private readonly keySource: VaultKeySource | undefined;
  /** Why the vault key can't be read, while sends wait for it (engram#677). */
  private keyProblem: VaultKeyUnreadable | undefined = undefined;
  private keyRetryAt = 0;
  private keyRetryStep = 0;
  /** The read of the key in flight. */
  private keyRead: Promise<void> | null = null;
  /** The key file went while its key was in use: said once (engram#693). */
  private keyGone = false;

  /**
   * `key.source`: where the key is read again, before each send and on the
   * interval (engram#693). Without one, `vaultKey` is the key for as long
   * as the scrubber runs. `key.problem`: the key couldn't be read at start,
   * so sends wait until it can be (engram#677); `vault` is null then, and
   * `vaultKey` undefined.
   */
  constructor(
    private vault: VaultLike | null,
    vaultKey: string | undefined,
    private readonly log: (msg: string) => void = () => {},
    key?: { source: VaultKeySource; problem?: unknown },
  ) {
    // Known before any read: scrubbed from the first message queued.
    if (vaultKey) this.useKey(vaultKey);
    this.keySource = key?.source;
    if (key?.problem !== undefined) {
      this.keyProblem = asVaultKeyProblem(key.problem);
      // It was read just now.
      this.keyRetryAt = Date.now() + READ_RETRY_MS[0];
      this.keyRetryStep = 1;
    }
  }

  /** True when there is anything to scrub against. */
  get active(): boolean {
    return this.values.size > 0 || this.keyForms.length > 0;
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
   * Before any of it, the key is read again (engram#693): one saved, or put
   * in place of the one in use, since the last send is the one the vault is
   * read with now, and ready() waits for that read. A key that can't be read
   * (engram#677) is read again only when its retry is due, and until it
   * reads, ready() is false, however long that takes.
   */
  async ready(): Promise<boolean> {
    if (this.stopped) return false;
    if (this.keySource !== undefined && (this.keyProblem === undefined || Date.now() >= this.keyRetryAt)) {
      await this.checkKey();
      if (this.stopped) return false;
    }
    if (this.keyProblem !== undefined) return false;
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

  /** Read now and on an interval: the key too, on the interval. */
  start(intervalMs = 10 * 60_000): void {
    this.stopped = false;
    // stop() dropped its spellings.
    if (this.vaultKey !== undefined) this.useKey(this.vaultKey);
    void this.refresh();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  /** The interval's read: the key, then the vault (engram#693). */
  private async tick(): Promise<void> {
    const vault = this.vault;
    if (this.keySource !== undefined) await this.checkKey();
    // Read through another client since, which a new key reads through.
    if (this.vault === vault) await this.refresh();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Drop plaintext the moment it is no longer needed. A read still in
    // flight finds the scrubber stopped and keeps nothing.
    this.values.clear();
    this.keyForms = [];
    this.settledFor = undefined;
    this.serverFailingSince = 0;
    this.released = false;
  }

  /**
   * Replace every exact occurrence of a known secret with its token, and of
   * each way a vault key in use, or used before, may be written. Longest
   * values first, so a secret that contains another secret is replaced
   * whole rather than leaving a readable fragment behind.
   */
  scrub(text: string): ScrubResult {
    if (!text || !this.active) return { text, replaced: [] };

    const ordered: Array<[string, string]> = [...this.values.entries()];
    const known = new Set(this.values.values());
    for (const form of this.keyForms) {
      if (known.has(form)) continue;
      known.add(form);
      ordered.push(["vault-key", form]);
    }
    ordered.sort((a, b) => b[1].length - a[1].length);
    let out = text;
    // A name's count, whichever of its values was found.
    const counts = new Map<string, number>();

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
      counts.set(name, (counts.get(name) ?? 0) + count);
    }
    return { text: out, replaced: [...counts].map(([name, count]) => ({ name, count })) };
  }

  /**
   * Scrub `key` from now on, each way it may be written, and the keys
   * before it still (engram#693): a key quoted after it was replaced is no
   * less a leak.
   */
  private useKey(key: string): void {
    const text = key.trim();
    this.vaultKey = text;
    const forms = vaultKeySpellings(text).filter((form) => form.length >= MIN_SCRUB_LENGTH);
    this.keyForms = [...new Set([...forms, ...this.keyForms])];
    if (text.length >= MIN_SCRUB_LENGTH) this.values.set("vault-key", text);
  }

  /** Read the key again: one read at a time. */
  private checkKey(): Promise<void> {
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
   * The key, read again. The one in use, however written: nothing more to
   * read, and a hold for it is lifted. The first, or another: scrub it from
   * now on (and the one before it still), and read the vault with it, which
   * sends wait for. It can't be read: hold sends, and try again on
   * READ_RETRY_MS. It isn't there: while holding, still wait, for the key
   * put back or a restart (engram#677); else go on with the key in use.
   */
  private async readKey(): Promise<void> {
    const source = this.keySource;
    if (source === undefined) return;
    if (this.keyProblem !== undefined) {
      // The next try, should this one fall short in any way.
      this.keyRetryAt = Date.now() + READ_RETRY_MS[Math.min(this.keyRetryStep, READ_RETRY_MS.length - 1)];
      this.keyRetryStep++;
    }
    let key: string | undefined;
    try {
      key = await source.read();
    } catch (err: unknown) {
      if (!this.stopped) this.holdForKey(asVaultKeyProblem(err));
      return;
    }
    if (this.stopped) return;

    if (key === undefined) {
      if (this.keyProblem !== undefined) {
        this.holdForKey(new VaultKeyUnreadable("isn't there any more", "gone"));
      } else if (this.vaultKey !== undefined && !this.keyGone) {
        this.keyGone = true;
        this.log(
          "vault scrubber: ~/.engram/vault-key isn't there any more — still scrubbing with the key " +
            "read before, and the secrets read with it. A restart starts without a key.",
        );
      }
      return;
    }
    this.keyGone = false;

    if (this.vaultKey !== undefined && sameVaultKey(key, this.vaultKey)) {
      // Written another way, perhaps: that is scrubbed too.
      this.useKey(key);
      if (this.keyProblem !== undefined) {
        this.liftKeyHold();
        this.log("vault scrubber: the vault key can be read again — sending what was held");
      }
      return;
    }

    let vault: VaultLike | null;
    try {
      vault = source.vaultWith(key.trim());
    } catch (err: unknown) {
      // Nothing to read the vault with: as a key that can't be read.
      this.holdForKey(this.keyProblem ?? asVaultKeyProblem(err));
      return;
    }
    const held = this.keyProblem !== undefined;
    const first = this.vaultKey === undefined;
    this.useKey(key);
    // Lifted, and at once the read through `vault` starts: ready() waits
    // for that read, as after any new client.
    this.liftKeyHold();
    const done = this.reconnect(vault);
    this.log(
      held
        ? first
          ? "vault scrubber: the vault key can be read now — reading the vault before sending what was held"
          : "vault scrubber: the vault key can be read now, and it is another key — reading the vault " +
            "with it before sending what was held"
        : first
          ? "vault scrubber: on — a vault key was saved; reading the vault with it before sending"
          : "vault scrubber: the vault key was replaced — reading the vault with the new one before " +
            "sending (the one it replaced is still scrubbed)",
    );
    await done;
  }

  /**
   * Sends wait for the key (engram#677): said when it starts, and again
   * when why changes.
   */
  private holdForKey(problem: VaultKeyUnreadable): void {
    if (this.keyProblem === undefined) {
      this.keyProblem = problem;
      this.keyRetryAt = Date.now() + READ_RETRY_MS[0];
      this.keyRetryStep = 1;
      this.log(
        `vault scrubber: holding sends — ${problem.message}. Capture goes on, and what it ` +
          "captures is sent once the key can be read.",
      );
      return;
    }
    const changed = problem.message !== this.keyProblem.message;
    this.keyProblem = problem;
    if (changed) this.log(`vault scrubber: still holding sends — ${problem.message}`);
  }

  private liftKeyHold(): void {
    this.keyProblem = undefined;
    this.keyRetryAt = 0;
    this.keyRetryStep = 0;
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
