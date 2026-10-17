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
 * vault key itself) in memory, and replaces exact occurrences in outgoing
 * message content with `[VAULT:name]` before anything is queued. That is the
 * same token form the SDK's resolveSecrets understands, so a recalled memory
 * still reads coherently and can still be resolved by a client with the key.
 *
 * What it never does: write a value to disk, include one in a log line, or
 * send one anywhere. Values are refreshed from the vault on an interval and
 * dropped on stop. The daemon already runs as the user who owns the 0600
 * key file and already holds the API key; this adds no new trust boundary,
 * only closes a leak inside the existing one.
 */

export interface VaultLike {
  list(): Promise<Array<{ name: string }>>;
  get(name: string): Promise<string | null>;
}

export interface ScrubResult {
  text: string;
  /** Number of replacements made. Names only — never the values. */
  replaced: Array<{ name: string; count: number }>;
}

/** Values shorter than this are not scrubbed: too likely to be coincidence. */
export const MIN_SCRUB_LENGTH = 4;

export class SecretScrubber {
  /** name → plaintext. The only place plaintext lives, and only in memory. */
  private values = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly vault: VaultLike | null,
    private readonly vaultKey: string | undefined,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  /** True when there is anything to scrub against. */
  get active(): boolean {
    return this.values.size > 0;
  }

  /** Names currently loaded. Safe to log. */
  get names(): string[] {
    return [...this.values.keys()];
  }

  /**
   * Load every secret's plaintext. Failures are non-fatal: the previous set
   * stays in force, so a transient network error can never turn scrubbing
   * off silently in the middle of a session.
   */
  async refresh(): Promise<void> {
    const next = new Map<string, string>();

    // The key itself is the most damaging thing to leak, and `engram vault
    // keygen` without --save prints it to the terminal.
    if (this.vaultKey && this.vaultKey.length >= MIN_SCRUB_LENGTH) {
      next.set("vault-key", this.vaultKey);
    }

    if (this.vault) {
      try {
        const entries = await this.vault.list();
        for (const { name } of entries) {
          try {
            const value = await this.vault.get(name);
            if (value && value.length >= MIN_SCRUB_LENGTH) next.set(name, value);
          } catch {
            // One unreadable secret must not block the rest.
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`vault scrubber: refresh failed, keeping previous set (${msg})`);
        if (this.values.size > 0) return;
      }
    }

    const before = this.values.size;
    this.values = next;
    if (next.size !== before) {
      this.log(`vault scrubber: protecting ${next.size} secret(s)`);
    }
  }

  /** Refresh now and on an interval. */
  start(intervalMs = 10 * 60_000): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Drop plaintext the moment it is no longer needed.
    this.values.clear();
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
}
