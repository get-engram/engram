/**
 * engram#698 — a daemon with no vault key can't remove the values of the
 * account's named secrets from what it captures: only pattern redaction
 * applies (scrubber.ts). That is right for an account with no vault. For one
 * that has secrets, a secret's value that comes up in a conversation is sent
 * as it is, and only daemon.log said why. The secrets may have been saved on
 * another machine, or from a shell whose ENGRAM_VAULT_KEY this daemon never
 * got (engram#690).
 *
 * So a daemon with no key asks whether the account has any: when it starts,
 * when the account changes, and when `engram vault set` or `engram vault
 * delete` says the vault changed (engram#701). Listing needs no key, and
 * gives names and metadata only. Only how many is kept, for status.json and
 * `engram status`: never a name, in a log line or anywhere else. Not on an
 * interval: each list is an audit row on the server.
 *
 * Sends don't wait for the key: that would stop capture on every machine
 * that has the account but not the key. A key that can't be read holds them
 * already (engram#677).
 */

import { plural } from "../output.js";
import { engramCommand } from "./package-runner.js";
import type { Account } from "./syncer.js";

/** How many named secrets an account's vault holds. Throws when it can't be told. */
export type CountSecrets = (account: Account) => Promise<number>;

export class MissingVaultKey {
  /** No key, and none that sends wait for: each check asks. */
  private keyless: boolean;
  /** The account the checks are for: undefined, signed out. */
  private account: Account | undefined = undefined;
  /**
   * Bumped when what was found no longer holds, for another account or a
   * key found: a check begun before keeps nothing.
   */
  private epoch = 0;
  /** The checks begun, and the last whose answer was kept: none replaces a later one's. */
  private begun = 0;
  private kept = 0;
  /** What status.json says: how many, or null for nothing to say. */
  private recorded: number | null = null;

  /**
   * `keyless`: the daemon started with no key, and none that can't be read
   * (that one holds sends instead). `record`: told how many the account's
   * vault holds while the daemon has no key, and null when there is nothing
   * to say, each time that changes.
   */
  constructor(
    private readonly count: CountSecrets,
    private readonly record: (secrets: number | null) => void,
    private readonly log: (msg: string) => void,
    keyless: boolean,
  ) {
    this.keyless = keyless;
  }

  /**
   * Whether `account`'s vault holds secrets, while the daemon has no key.
   * Another account than the last: what was found for that one goes at once,
   * and an answer about it that comes later is dropped. Signed out
   * (undefined): nothing to say. A list that fails changes nothing, and this
   * never throws.
   */
  async check(account: Account | undefined): Promise<void> {
    if (!this.keyless) return;
    if (account !== this.account) {
      this.account = account;
      this.epoch++;
      this.set(null);
    }
    if (account === undefined) return;
    const epoch = this.epoch;
    const check = ++this.begun;
    let secrets: number;
    try {
      secrets = await this.count(account);
    } catch {
      // Can't tell, so nothing changes: the server may be out of reach, or
      // the key may not be allowed to list. Never the error, which may hold
      // the server's address.
      return;
    }
    if (epoch !== this.epoch || check < this.kept) return;
    this.kept = check;
    this.set(Number.isSafeInteger(secrets) && secrets > 0 ? secrets : null);
  }

  /**
   * The daemon has a key now, or holds sends for one it can't read: from
   * here on it is never without one (scrubber.ts). A check in flight keeps
   * nothing.
   */
  keyFound(): void {
    this.keyless = false;
    this.epoch++;
    this.set(null);
  }

  /**
   * Said in the log when there are some, then recorded: whoever finds the
   * count in status.json finds the line in daemon.log too. A status write or
   * a log that throws throws nothing here.
   */
  private set(secrets: number | null): void {
    if (secrets === this.recorded) return;
    this.recorded = secrets;
    if (secrets !== null) {
      const values = secrets === 1 ? "its value isn't" : "their values aren't";
      try {
        this.log(
          `vault scrubber: off, and this account's vault has ${plural(secrets, "secret")} — with no ` +
            `vault key, ${values} removed from what is captured. Put the key in ~/.engram/vault-key ` +
            `(${engramCommand("vault save-key")}): it is read before the next send.`,
        );
      } catch {
        // Recorded in status.json all the same.
      }
    }
    try {
      this.record(secrets);
    } catch {
      // status.json is best effort.
    }
  }
}
