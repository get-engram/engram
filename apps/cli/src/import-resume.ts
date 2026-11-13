import { createHash, type Hash } from "node:crypto";
import type { Conversation, Message, MessageInput } from "@getengram/sdk";
import { classifyError } from "./daemon/status.js";
import { boundContent } from "./message-bounds.js";

/**
 * Picking an interrupted import up where it stopped (engram#751).
 *
 * `engram import` used to be all or nothing for each conversation: one that
 * Engram already had was skipped as "already imported". So a conversation
 * cut off partway, by a rate limit, a lost connection, a plan limit or
 * Ctrl+C, kept only its first messages however often the import ran again.
 *
 * Now each request that stores a conversation's messages carries a marker,
 * the import cursor. It says how many of the file's messages Engram has
 * once that request is stored, with a digest of them. Engram takes it off
 * the message and records it on the conversation in the same write as the
 * messages (apps/mcp-server/src/services/import-cursor.ts), so it is never
 * ahead of or behind what is stored. A re-run reads it and sends the rest.
 *
 * Counting the conversation's messages can't stand in for it: deleting a
 * message lowers the count, so a re-run that trusted it would send one
 * message twice, or bring back one the user deleted.
 */

export const IMPORT_CURSOR_KEY = "import_cursor";

export interface ImportCursor {
  v: 1;
  /** How many of the source conversation's messages Engram has. */
  next: number;
  /** ImportDigest of those messages, hex. */
  digest: string;
}

const DIGEST = /^[0-9a-f]{64}$/;

/**
 * A cursor exactly as the CLI writes it, or null. The same rules as the
 * worker's parseImportCursor (a test runs both over the same values): what
 * Engram records is what a re-run reads.
 */
export function parseImportCursor(value: unknown): ImportCursor | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const c = value as Record<string, unknown>;
  if (c.v !== 1) return null;
  if (typeof c.next !== "number" || !Number.isSafeInteger(c.next) || c.next < 1) return null;
  if (typeof c.digest !== "string" || !DIGEST.test(c.digest)) return null;
  return { v: 1, next: c.next, digest: c.digest };
}

/**
 * What a cursor's digest covers: each message's role and length, in order,
 * and never its words.
 *
 * It only has to tell whether the file still begins with the messages an
 * earlier run sent, and a different version of a conversation (an earlier
 * message edited, another branch followed) changes the lengths. A hash of
 * the text would do that too, but it would sit in Engram next to messages
 * whose secrets were taken out of them: [VAULT:…] for what the vault
 * encrypted on this machine, [REDACTED] for what Engram redacts. Anyone
 * who could read the conversation could then test guesses at a short
 * secret, a password or an SSN, against the hash, offline. The lengths
 * give them nothing to test a guess against.
 */
export class ImportDigest {
  private readonly hash: Hash = createHash("sha256").update("engram-import-cursor/1\n");

  add(m: MessageInput): void {
    this.hash.update(`${m.role} ${m.content.length}\n`);
  }

  hex(): string {
    return this.hash.copy().digest("hex");
  }
}

/** The digest of the first `n` messages. */
export function prefixDigest(messages: readonly MessageInput[], n: number): string {
  const digest = new ImportDigest();
  for (let i = 0; i < n; i++) digest.add(messages[i]);
  return digest.hex();
}

/** The batch with `cursor` in its last message's metadata, the one place Engram reads it. */
export function markBatch(batch: readonly MessageInput[], cursor: ImportCursor): MessageInput[] {
  const marked = batch.slice();
  const last = marked[marked.length - 1];
  marked[marked.length - 1] = { ...last, metadata: { ...last.metadata, [IMPORT_CURSOR_KEY]: cursor } };
  return marked;
}

/** What a re-run does with a conversation Engram already has. */
export type ResumePlan =
  /** Send the file's messages from `from` on: Engram has the ones before. */
  | { kind: "send"; from: number }
  /** Engram has every message the file has. */
  | { kind: "done" }
  /** The file's copy of the conversation differs from the one imported before. */
  | { kind: "changed" }
  /** Engram has `stored` messages and can't tell they're the file's first ones. */
  | { kind: "kept"; stored: number }
  /** Imported before the cursor: read what Engram has and compare (planFromStored). */
  | { kind: "check" };

/** A plan with nothing left to check. */
export type SettledPlan = Exclude<ResumePlan, { kind: "check" }>;

/**
 * A time as Engram's database writes it ("2026-11-12 20:55:44", UTC), in
 * milliseconds, or null for anything else.
 */
export function serverTime(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z?$/.test(value)) {
    return null;
  }
  const t = Date.parse(`${value.replace(" ", "T").replace(/Z$/, "")}Z`);
  return Number.isFinite(t) ? t : null;
}

/**
 * What to do with a conversation Engram already has, from what Engram says
 * of it: its cursor, else (imported before there was one) its message count
 * and times.
 */
export function planResume(conversation: Conversation, source: readonly MessageInput[]): ResumePlan {
  const metadata: unknown = conversation.metadata;
  const recorded =
    metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)[IMPORT_CURSOR_KEY]
      : undefined;
  const cursor = parseImportCursor(recorded);
  if (cursor) {
    // Deleted messages don't matter here: the cursor counts what was sent.
    if (cursor.next > source.length || cursor.digest !== prefixDigest(source, cursor.next)) {
      return { kind: "changed" };
    }
    return cursor.next === source.length ? { kind: "done" } : { kind: "send", from: cursor.next };
  }

  const stored = conversation.messageCount;
  if (!Number.isSafeInteger(stored) || stored < 0) return { kind: "kept", stored: 0 };
  if (stored >= source.length) return { kind: "done" };
  if (stored > 0) return { kind: "check" };
  // Empty. Send it all only if nothing was ever written to it: an append
  // and a message delete each move updated_at, so a conversation emptied
  // by deletes is the user's, and stays as it is.
  const created = serverTime(conversation.createdAt);
  return created !== null && conversation.updatedAt === conversation.createdAt
    ? { kind: "send", from: 0 }
    : { kind: "kept", stored: 0 };
}

/**
 * Most an append's last message and the conversation's update time can
 * differ by. Engram's database writes both, to the second, in the one batch
 * that stores the messages, so they differ by a second at most, when the
 * batch runs across one. The rest is margin.
 */
export const SAME_WRITE_MS = 2_000;

/**
 * What to do with a conversation imported before there were cursors, from
 * every message Engram has of it (`stored`, in order) and the conversation
 * as Engram described it when the last of them was read.
 *
 * Engram's messages must be exactly the file's first ones, role for role,
 * and the last thing written to the conversation must be the append that
 * stored the last of them: deleting a message moves the conversation's
 * update time, so a conversation whose last messages the user deleted is
 * left as it is rather than given them back. Anything that can't be
 * checked (a body hidden by the account's privacy setting, a time that
 * doesn't parse, a count that moved while reading) leaves it as it is too.
 */
export function planFromStored(
  stored: readonly Message[],
  conversation: Conversation,
  source: readonly MessageInput[],
): SettledPlan {
  if (stored.length >= source.length) return { kind: "done" };
  const kept: SettledPlan = { kind: "kept", stored: stored.length };
  if (stored.length === 0 || conversation.messageCount !== stored.length) return kept;
  for (const [i, m] of stored.entries()) {
    const want = source[i];
    if (m.role !== want.role || typeof m.content !== "string") return kept;
    if (!sameAsStored(m.content, want.content) && !sameAsStored(m.content, boundContent(want.content))) {
      return kept;
    }
  }
  const last = serverTime(stored[stored.length - 1].createdAt);
  const updated = serverTime(conversation.updatedAt);
  if (last === null || updated === null || Math.abs(updated - last) > SAME_WRITE_MS) return kept;
  return { kind: "send", from: stored.length };
}

/**
 * At most how many of the file's messages an import sends to a conversation
 * Engram already has, from what Engram says of the conversation without
 * reading its messages (engram#754): what planExisting plans, and for one
 * imported before there was a cursor, the messages past the ones Engram
 * has, which is what it sends when those are the file's first ones.
 */
export function mostToSend(conversation: Conversation, source: readonly MessageInput[]): number {
  if (conversation.messageCount >= source.length) return 0;
  const plan = planResume(conversation, source);
  if (plan.kind === "send") return source.length - plan.from;
  if (plan.kind === "check") return source.length - conversation.messageCount;
  return 0;
}

/** What stands in for text Engram didn't store: Engram's redaction, and the vault's reference to a secret it encrypted. */
const STAND_IN = /\[REDACTED\]|\[VAULT:[^\]\s]{1,100}\]/g;

/**
 * Whether `stored` is `source` as Engram stores it: the same text, but
 * where `stored` has a stand-in for something taken out ([REDACTED], or
 * [VAULT:…]), `source` has at least one character of anything.
 *
 * Read in one pass, with no regular expression built from either text:
 * each piece of text between stand-ins is found at the first place it can
 * start, which leaves the most room for the pieces after it, so the first
 * match found is a match if any is.
 */
export function sameAsStored(stored: string, source: string): boolean {
  const pieces = stored.split(STAND_IN);
  if (pieces.length === 1) return stored === source;
  const head = pieces[0];
  const tail = pieces[pieces.length - 1];
  if (!source.startsWith(head) || !source.endsWith(tail)) return false;
  const end = source.length - tail.length;
  let at = head.length;
  for (const piece of pieces.slice(1, -1)) {
    const found = source.indexOf(piece, at + 1);
    if (found === -1) return false;
    at = found + piece.length;
  }
  return end - at >= 1;
}

/** A refusal that says nothing was stored, and passes: waited out, then tried again. */
export type Waitable = "rate_limit" | "paused";

/** How long a call waits out one kind of refusal in a row before the import stops. */
export const PATIENCE_MS: Record<Waitable, number> = { rate_limit: 15 * 60_000, paused: 30 * 60_000 };

/** The import stopped waiting: Engram kept refusing for longer than PATIENCE_MS. */
export class StillRefused extends Error {
  constructor(
    readonly kind: Waitable,
    readonly refusal: unknown,
  ) {
    super(kind === "paused" ? "Engram is still paused for maintenance" : "Engram is still limiting how fast this account can save");
    this.name = "StillRefused";
  }
}

/** The waits, replaceable in tests. */
export const importTiming = {
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
  random: (): number => Math.random(),
};

/** The wait before try `attempt + 1` of a rate-limited call: 5 s doubling to a minute, each with some jitter. */
export function rateLimitWait(attempt: number, random = importTiming.random()): number {
  const base = Math.min(60_000, 5_000 * 2 ** Math.min(attempt, 4));
  return Math.round(base / 2 + (random * base) / 2);
}

/** The wait between tries while Engram is paused for maintenance. */
export const PAUSE_WAIT_MS = 30_000;

/**
 * A caller that waits out a rate limit or a maintenance pause and tries
 * again: Engram refuses both before anything is written, so trying again
 * can't store a message twice. Every other failure is thrown at once.
 * `say` hears of each kind once, the first time a call waits for it.
 */
export function patientCaller(say: (kind: Waitable) => void): <T>(call: () => Promise<T>) => Promise<T> {
  const said = new Set<Waitable>();
  return async function patiently<T>(call: () => Promise<T>): Promise<T> {
    let waited = 0;
    let attempt = 0;
    for (;;) {
      try {
        return await call();
      } catch (err) {
        const kind = classifyError(err);
        if (kind !== "rate_limit" && kind !== "paused") throw err;
        const wait = kind === "paused" ? PAUSE_WAIT_MS : rateLimitWait(attempt++);
        if (waited + wait > PATIENCE_MS[kind]) throw new StillRefused(kind, err);
        if (!said.has(kind)) {
          said.add(kind);
          say(kind);
        }
        await importTiming.sleep(wait);
        waited += wait;
      }
    }
  };
}
