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
 * A vault key that reads, but decrypts none of the vault's secrets
 * (engram#694) — another machine's, or a new one made after the key was
 * lost — sent every secret as it was, and only the log said so. Now sends
 * wait while it lasts, as for a key that can't be read: no bound releases
 * them. A secret that decrypted before, through this account, and hasn't
 * been saved again since, is scrubbed with the value read then: a key
 * replaced while the daemon runs holds sends only once a secret it can't
 * scrub is saved, or at a restart. The hold lifts once a complete read
 * finds none it can't scrub: each decrypts, or was deleted, or saved
 * again with this key. Saved again one at a time, the first that decrypts
 * doesn't lift it: what waits would go with the others in it. Nor does a
 * restart meanwhile: status.json says the daemon before held, and
 * worker-main goes on holding (continueMismatchHold). While it holds, the
 * vault is listed again on
 * MISMATCH_RETRY_MS, and read in full when the list changes, and at least
 * every MISMATCH_REREAD_MS. A key that decrypts some of the secrets but
 * not others, with no hold before, doesn't hold; `engram status` says how
 * many it can't scrub.
 *
 * A secret saved with `engram vault set` while the daemon runs
 * (engram#701) used to go out as it was until the interval read the vault
 * again, up to 10 minutes later. Now `engram vault set` and `engram vault
 * delete` leave a notice in ~/.engram (vault-changed.ts), which is looked
 * for before each send and on the interval. A new one makes the next send
 * wait for a read of the vault begun after it, as the first send waits
 * for the first read. A read already under way when it came may have
 * listed the vault before the change, so it doesn't count, and another
 * follows it. A secret saved anywhere else, such as on another machine,
 * is read on the interval still.
 *
 * What it never does: write a value to disk, include one in a log line, or
 * send one anywhere. Values are refreshed from the vault on an interval and
 * dropped on stop. The daemon already runs as the user who owns the 0600
 * key file and already holds the API key; this adds no new trust boundary,
 * only closes a leak inside the existing one.
 */

import { isRefusal } from "./status.js";
import {
  asVaultKeyProblem,
  sameVaultKey,
  vaultKeySpellings,
  VaultKeyMismatch,
  VaultKeyUnreadable,
} from "../vault-key.js";

export interface VaultLike {
  /**
   * `updatedAt`: when the secret was last saved, as the server says it. It
   * tells a secret saved again from one that wasn't (engram#694).
   */
  list(): Promise<Array<{ name: string; updatedAt?: string }>>;
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
 * What a complete read found of the secrets the vault key doesn't decrypt
 * (engram#694): how many, how many of those have no value known from
 * before, so can't be scrubbed, and how many it does decrypt. Counts only,
 * never a name. `held`: sends wait for them.
 */
export interface Undecryptable {
  secrets: number;
  unscrubbed: number;
  decrypted: number;
  held: boolean;
}

/**
 * While sends wait for secrets the key doesn't decrypt (engram#694): list
 * the vault again in 10 s → 30 s → 1 min → 2 min → 5 min → 5 min …
 */
export const MISMATCH_RETRY_MS = [10_000, 30_000, 60_000, 120_000, 300_000];

/** …and read each secret again at least this often, though the list is the same. */
export const MISMATCH_REREAD_MS = 10 * 60_000;

/** What a list says of each secret: its name, and when it was last saved. */
function fingerprint(entries: Array<{ name: string; updatedAt?: string }>): string {
  return JSON.stringify(
    entries
      .map((e): [string, string | null] => [e.name, e.updatedAt ?? null])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  );
}

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

/**
 * A vault read that failed here, not in the request: the value doesn't
 * decrypt with this vault key (engram#694). `engram vault list --check`
 * judges each secret as the daemon does.
 */
export function decryptFailed(err: unknown): boolean {
  return failureOf(err) === "local";
}

function errorName(err: unknown): string {
  const name = err !== null && typeof err === "object" ? (err as { name?: unknown }).name : undefined;
  return typeof name === "string" ? name : "";
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The notice that the vault changed there now (engram#701), as a value
 * that differs from the last for each new one; null when there is none.
 */
export type VaultChanges = () => string | null;

interface Read {
  vault: VaultLike | null;
  /** The notices seen when it began: a read begun before the last isn't a read of the vault as it is now. */
  count: number;
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
  /** How many secrets don't decrypt with the key, as last said. */
  private undecryptable = 0;
  /** Of those, how many have no value known from before, as last said. */
  private unscrubbed = 0;
  /**
   * Sends wait for secrets the key doesn't decrypt, with no value known
   * from before (engram#694): from a complete read that found it decrypts
   * none of the vault's secrets, or from the daemon before, until one finds
   * none it can't scrub.
   */
  private mismatch: VaultKeyMismatch | undefined = undefined;
  /** The list it was found with. Undefined: read each secret next time. */
  private mismatchPrint: string | undefined = undefined;
  /** When each secret was last read while it holds. */
  private fullReadAt = 0;
  /**
   * The secrets whose value is known: name → when it was last saved, as
   * listed when it decrypted through this account, with the key in use or
   * one before it. Not saved again since, the value read then is its value.
   */
  private own = new Map<string, string | undefined>();

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

  /** Where to look for notices that the vault changed (engram#701). */
  private changes: VaultChanges | undefined = undefined;
  /** The notice last seen. */
  private changeSeen: string | null = null;
  /** How many new notices have been seen. */
  private changeCount = 0;

  /**
   * `key.source`: where the key is read again, before each send and on the
   * interval (engram#693). Without one, `vaultKey` is the key for as long
   * as the scrubber runs. `key.problem`: the key couldn't be read at start,
   * so sends wait until it can be (engram#677); `vault` is null then, and
   * `vaultKey` undefined. `report`: told what each complete read finds of
   * secrets the key doesn't decrypt, and nothing on a new client
   * (engram#694).
   */
  constructor(
    private vault: VaultLike | null,
    vaultKey: string | undefined,
    private readonly log: (msg: string) => void = () => {},
    key?: { source: VaultKeySource; problem?: unknown },
    private readonly report?: (found: Undecryptable) => void,
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

  /**
   * Why sends wait, while ready() is false: a VaultKeyUnreadable while the
   * key can't be read, a VaultKeyMismatch while they wait for secrets it
   * doesn't decrypt (engram#694), else why the vault couldn't be read
   * through the current client.
   */
  get failure(): unknown {
    return this.keyProblem ?? this.mismatch ?? this.lastFailure;
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
    const read: Read = { vault, count: this.changeCount, done: Promise.resolve() };
    read.done = this.read(vault, read.count)
      .catch((err: unknown) => {
        this.fellShort(vault, err, "server");
        this.log(`vault scrubber: read failed (${errorText(err)})`);
      })
      .catch(() => {}) // a log that throws: ready() mustn't
      .finally(() => {
        if (this.reading !== read) return;
        this.reading = null;
        // The vault changed while it was under way (engram#701): read it
        // again, and a ready() waiting on this read waits for that one.
        if (read.count !== this.changeCount) void this.refresh();
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
   *
   * A key that decrypts none of the vault's secrets (engram#694) holds the
   * same way: no bound releases it. The vault is listed again when its
   * retry is due, on MISMATCH_RETRY_MS.
   *
   * First of all, a new notice that the vault changed (engram#701) means
   * the set no longer covers it: ready() waits for a read begun after the
   * notice, at once, and as for the first read.
   */
  async ready(): Promise<boolean> {
    if (this.stopped) return false;
    this.checkChanges();
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
   * (engram#587), or it signed out. Reads at once, and ready() waits for
   * that read. Until it settles, the current set stays in force, and a read
   * that fails keeps it too. What was found of the key against the vault
   * goes (engram#694): it may be another account's vault.
   */
  reconnect(vault: VaultLike | null): Promise<void> {
    this.mismatch = undefined;
    this.own = new Map();
    this.undecryptable = 0;
    this.unscrubbed = 0;
    this.tell({ secrets: 0, unscrubbed: 0, decrypted: 0, held: false });
    return this.readThrough(vault);
  }

  /**
   * Read through `vault` from now on: a new client, or the vault read with
   * a new key. Reads each secret, though the list is the same: a new key
   * may decrypt what the last one didn't (engram#694).
   */
  private readThrough(vault: VaultLike | null): Promise<void> {
    this.vault = vault;
    this.mismatchPrint = undefined;
    this.settledFor = undefined;
    this.lastFailure = undefined;
    this.retryAt = 0;
    this.retryStep = 0;
    this.serverFailingSince = 0;
    this.released = false;
    this.refusalLogged = false;
    return this.refresh();
  }

  /**
   * The daemon before this one held sends for secrets its vault key didn't
   * decrypt (engram#694), and `found` is what its last complete read found.
   * They wait still, as if this one had held them: no bound releases them,
   * until a complete read finds none it can't scrub. One that finds a
   * secret it can't scrub goes on holding, though the key decrypts others,
   * as saving them again one at a time does. Call before start().
   */
  continueMismatchHold(found: { secrets: number; unscrubbed: number; decrypted: number }): void {
    this.mismatch = new VaultKeyMismatch(Math.max(1, found.secrets), Math.max(0, found.decrypted));
    this.undecryptable = this.mismatch.secrets;
    this.unscrubbed = Math.max(1, found.unscrubbed);
    this.log(
      "vault scrubber: the daemon before held sends for secrets its vault key didn't decrypt — " +
        "holding them still, until a read of the vault finds none that can't be scrubbed",
    );
  }

  /**
   * Look for notices that the vault changed (engram#701), before each send
   * and on the interval: `engram vault set` and `engram vault delete` leave
   * one. The notice there now changes nothing: start() reads the vault
   * anyway. Call before start().
   */
  followChanges(changes: VaultChanges): void {
    this.changes = changes;
    this.changeSeen = this.noticeNow();
  }

  /** The notice there now. A reader that throws finds none. */
  private noticeNow(): string | null {
    try {
      return this.changes?.() ?? null;
    } catch {
      return null;
    }
  }

  /**
   * A new notice that the vault changed (engram#701): the set may not cover
   * the vault now. The next send waits for a read begun after it, which
   * ready() starts at once. A hold released at the bound tries once more
   * before it lets sends go, and one for secrets the key doesn't decrypt
   * reads each secret, though the list is the same. A notice removed, or
   * one that can't be read, changes nothing, nor does the same one read
   * again after: each notice says something of its own.
   */
  private checkChanges(): void {
    const notice = this.noticeNow();
    if (notice === null || notice === this.changeSeen) return;
    this.changeSeen = notice;
    this.changeCount++;
    this.settledFor = undefined;
    this.retryAt = 0;
    this.released = false;
    this.mismatchPrint = undefined;
    this.log("vault scrubber: the vault changed — reading it again before sending");
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
    // Seen now, the notice needs no read but this one (engram#701).
    this.checkChanges();
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
    this.own = new Map();
    this.settledFor = undefined;
    this.serverFailingSince = 0;
    this.released = false;
    this.mismatch = undefined;
    this.mismatchPrint = undefined;
    this.fullReadAt = 0;
    this.undecryptable = 0;
    this.unscrubbed = 0;
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
    // for that read, as after any new client. The same account's vault: a
    // hold for a key that doesn't match it stays until that read is done,
    // and a value read with the key before is its value still (engram#694).
    this.liftKeyHold();
    const done = this.readThrough(vault);
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

  /**
   * The server has failed the read for MAX_SERVER_HOLD_MS, and sends don't
   * wait for secrets the key doesn't decrypt (engram#694): sending then
   * would send what can't be scrubbed.
   */
  private pastBound(): boolean {
    return (
      !this.stopped &&
      this.mismatch === undefined &&
      this.serverFailingSince !== 0 &&
      Date.now() - this.serverFailingSince >= MAX_SERVER_HOLD_MS
    );
  }

  private async read(vault: VaultLike | null, count: number): Promise<void> {
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
    // What the read finds of the key against the vault (engram#694): the
    // secrets it decrypts, those it doesn't, and of those, the ones with no
    // value known from before. Counted only when each secret got an answer.
    let decrypted = 0;
    let undecryptable = 0;
    let unknown = 0;
    let counted = true;
    const own = new Map<string, string | undefined>();
    let print: string | undefined;

    if (vault) {
      let entries: Array<{ name: string; updatedAt?: string }> = [];
      let listed = false;
      try {
        entries = await vault.list();
        listed = true;
      } catch (err) {
        const failure = failureOf(err);
        if (failure === "refused") {
          refused = err;
        } else {
          counted = false;
          this.log(
            `vault scrubber: reading the vault failed, keeping the ${this.values.size} secret(s) ` +
              `already known (${errorText(err)})`,
          );
          // A list that didn't come back is a gap of unknown size.
          if (!rereading) short = { err, failure: failure === "network" ? "network" : "server" };
        }
        // Nothing was read: every secret already known stays in force.
        for (const [name, value] of this.values) next.set(name, value);
        for (const [name, saved] of this.own) own.set(name, saved);
      }

      if (listed) {
        print = fingerprint(entries);
        if (
          this.mismatch !== undefined &&
          print === this.mismatchPrint &&
          Date.now() - this.fullReadAt < MISMATCH_REREAD_MS
        ) {
          // Nothing listed has changed since the read that held sends: each
          // would read as it did then.
          if (this.stopped || vault !== this.vault) return;
          this.serverFailingSince = 0;
          this.mismatchRetry();
          return;
        }
      }

      // After a request that got no answer, the rest would only wait out the
      // same timeout.
      let unreachable: { err: unknown } | null = null;
      for (const { name, updatedAt } of entries) {
        let err: unknown;
        if (unreachable) {
          err = unreachable.err;
        } else {
          try {
            const value = await vault.get(name);
            // Deleted since it was listed: nothing to scrub, nor to count.
            if (typeof value !== "string") continue;
            decrypted++;
            own.set(name, updatedAt);
            if (value.length >= MIN_SCRUB_LENGTH) next.set(name, value);
            continue;
          } catch (e) {
            err = e;
          }
        }
        // One unreadable secret must not block the rest, nor drop the value
        // already known for it (engram#588).
        const previous = this.values.get(name);
        if (previous !== undefined) next.set(name, previous);
        if (this.own.has(name)) own.set(name, this.own.get(name));
        const failure = failureOf(err);
        if (failure === "refused") {
          refused ??= err;
          continue;
        }
        if (failure === "local") {
          undecryptable++;
          // Its value is known still if it decrypted before, through this
          // account, and hasn't been saved again since.
          if (!(this.own.has(name) && this.own.get(name) === updatedAt)) unknown++;
          continue;
        }
        counted = false;
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
    this.own = own;
    if (next.size !== before) {
      this.log(`vault scrubber: protecting ${next.size} secret(s)`);
    }

    // The vault changed while this read was under way (engram#701): it may
    // have listed the vault before the change. What it read is in force,
    // but the read that follows it decides the rest.
    if (count !== this.changeCount) return;

    if (short) {
      this.fellShort(vault, short.err, short.failure);
      return;
    }

    // Only a read in which each secret got an answer says what the key
    // decrypts: a hold for it starts, or ends, only on one (engram#694).
    if (counted) {
      // Once sends wait, they wait until none is left that can't be
      // scrubbed: saved again one at a time, the first that decrypts
      // mustn't send what waits with the others in it.
      const hold = unknown > 0 && (decrypted === 0 || this.mismatch !== undefined);
      this.tell({ secrets: undecryptable, unscrubbed: unknown, decrypted, held: hold });
      if (hold) {
        this.holdForMismatch(new VaultKeyMismatch(undecryptable, decrypted), unknown, print);
        return;
      }
      if (this.mismatch !== undefined) this.liftMismatch(decrypted, undecryptable, refused);
      this.sayUndecryptable(undecryptable, unknown);
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

  /**
   * Sends wait for secrets the key doesn't decrypt, with no value known
   * from before (engram#694): no bound releases them. Said when it starts,
   * and again when the count changes, or the vault read with a new key
   * finds the same. The vault is listed again on MISMATCH_RETRY_MS.
   */
  private holdForMismatch(mismatch: VaultKeyMismatch, unknown: number, print: string | undefined): void {
    const was = this.mismatch;
    // Each secret read again, as after a new key.
    const recheck = this.mismatchPrint === undefined;
    this.mismatch = mismatch;
    this.mismatchPrint = print;
    this.fullReadAt = Date.now();
    this.settledFor = undefined;
    this.lastFailure = undefined;
    this.serverFailingSince = 0;
    this.released = false;
    if (was === undefined) this.retryStep = 0;
    this.mismatchRetry();
    this.undecryptable = mismatch.secrets;
    this.unscrubbed = unknown;
    if (was === undefined) {
      const one = mismatch.secrets === 1;
      this.log(
        `vault scrubber: holding sends — ${mismatch.message}, so ${one ? "it" : "they"} can't ` +
          `${unknown < mismatch.secrets ? "all " : ""}be scrubbed. Capture goes on, and what it ` +
          `captures is sent once ${one ? "the secret decrypts, or is" : "the secrets decrypt, or are"} ` +
          "deleted. See 'engram status'.",
      );
    } else if (was.secrets !== mismatch.secrets || recheck) {
      this.log(`vault scrubber: still holding sends — ${mismatch.message}`);
    }
  }

  /** The next read while sends wait for secrets the key doesn't decrypt. */
  private mismatchRetry(): void {
    this.retryAt = Date.now() + MISMATCH_RETRY_MS[Math.min(this.retryStep, MISMATCH_RETRY_MS.length - 1)];
    this.retryStep++;
  }

  /**
   * A complete read finds none it can't scrub (engram#694): what waits goes.
   * Those the key doesn't decrypt, if any, have a value known from before.
   */
  private liftMismatch(decrypted: number, undecryptable: number, refused: unknown): void {
    this.mismatch = undefined;
    this.mismatchPrint = undefined;
    const why =
      undecryptable === 0 && decrypted > 0
        ? "the vault key decrypts the vault's secrets now"
        : undecryptable === 0 && refused !== undefined
          ? "this API key can't read the vault now"
          : "the vault holds no secret now that can't be scrubbed";
    this.log(`vault scrubber: ${why} — sending what was held`);
  }

  /**
   * Say what a complete read finds of the secrets the key doesn't decrypt,
   * when that changes: those with no value known from before go out as
   * they are; the rest are scrubbed with the value read before, until a
   * restart (engram#694).
   */
  private sayUndecryptable(undecryptable: number, unknown: number): void {
    if (undecryptable === this.undecryptable && unknown === this.unscrubbed) return;
    this.undecryptable = undecryptable;
    this.unscrubbed = unknown;
    if (unknown > 0) {
      this.log(
        `vault scrubber: ${unknown} secret(s) don't decrypt with this vault key, ` +
          `so they can't be scrubbed`,
      );
    } else if (undecryptable > 0) {
      this.log(
        `vault scrubber: ${undecryptable} secret(s) don't decrypt with this vault key — scrubbing ` +
          "them with the value read before, which a restart won't have",
      );
    }
  }

  /** Tell the daemon's status what a read found (engram#694). */
  private tell(found: Undecryptable): void {
    try {
      this.report?.(found);
    } catch {
      // A status that can't be written changes nothing here.
    }
  }
}
