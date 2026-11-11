import {
  TIER_LIMITS,
  MAX_MESSAGE_CONTENT_CHARS,
  chunkMessages,
  generateId,
  type Tier,
  type Message,
} from "@getengram/shared";
import { stripBinaryPayloads } from "./binary-payloads.js";
import {
  getCurrentPeriod,
  getOrCreateUsage,
  atomicIncrementMessages,
  incrementMessagesStored,
  releaseMessagesStored,
  incrementSearchesRun,
  atomicIncrementSearches,
  incrementChunksIndexed,
  atomicIncrementChunksIndexed,
  releaseChunksIndexed,
  incrementApiRequests,
  atomicIncrementStorage,
  incrementStorage,
  decrementStorage,
  getStorageUsed,
  getOrganizationById,
} from "@getengram/db";

export interface TierCheckResult {
  allowed: boolean;
  error?: string;
  limit?: number;
  used?: number;
  tier?: Tier;
}

/**
 * Ensure a usage row exists for `period` (default: now) and return it.
 * Single D1 round trip via INSERT ... ON CONFLICT ... RETURNING.
 */
async function ensureUsage(db: D1Database, organizationId: string, period?: string) {
  const id = generateId("usg");
  return getOrCreateUsage(db, id, organizationId, period);
}

/**
 * Atomically check the message limit AND increment the counter in one
 * operation. Prevents race conditions where concurrent requests both
 * pass the check but together exceed the limit.
 *
 * For unlimited tiers, skips the atomic check and just increments.
 * `period` pins every statement to one month (see reserveAppend).
 */
export async function checkAndTrackMessages(
  db: D1Database,
  organizationId: string,
  tier: Tier,
  messageCount: number,
  period: string = getCurrentPeriod(),
): Promise<TierCheckResult> {
  const limits = TIER_LIMITS[tier];

  // Ensure usage row exists
  await ensureUsage(db, organizationId, period);

  // Unlimited tier — just increment, no limit check
  if (limits.messages_per_month === -1) {
    await incrementMessagesStored(db, organizationId, messageCount, period);
    return { allowed: true };
  }

  // Atomic: increment only if within limit
  const result = await atomicIncrementMessages(
    db,
    organizationId,
    messageCount,
    limits.messages_per_month,
    period,
  );

  if (!result) {
    // Limit would be exceeded — fetch current usage for error message
    const usage = await ensureUsage(db, organizationId, period);
    const used = (usage as { messages_stored: number }).messages_stored;
    return {
      allowed: false,
      error: "message_limit_exceeded",
      limit: limits.messages_per_month,
      used,
      tier,
    };
  }

  // Success — surface the new count + limit so callers can show a usage meter.
  return {
    allowed: true,
    used: result.messages_stored,
    limit: limits.messages_per_month,
    tier,
  };
}

export async function checkMessageLimit(
  db: D1Database,
  organizationId: string,
  tier: Tier,
  messageCount: number
): Promise<TierCheckResult> {
  const limits = TIER_LIMITS[tier];

  if (limits.messages_per_month === -1) {
    return { allowed: true };
  }

  const usage = await ensureUsage(db, organizationId);
  const used = (usage as { messages_stored: number }).messages_stored;
  const remaining = limits.messages_per_month - used;

  if (messageCount > remaining) {
    return {
      allowed: false,
      error: "message_limit_exceeded",
      limit: limits.messages_per_month,
      used,
      tier,
    };
  }

  return { allowed: true };
}

/**
 * Increment messages_stored counter. Assumes usage row already exists
 * (checkMessageLimit ensures it via ensureUsage).
 */
export async function trackMessagesStored(
  db: D1Database,
  organizationId: string,
  count: number
) {
  await incrementMessagesStored(db, organizationId, count);
}

/**
 * Count one search against the period's search budget BEFORE the search
 * runs (engram#451). The query embedding and the vector + FTS query are
 * the cost being bounded, so the gate sits in front of them; tiers without
 * a budget just count.
 */
export async function checkAndTrackSearch(
  db: D1Database,
  organizationId: string,
  tier: Tier,
): Promise<TierCheckResult> {
  const limit = TIER_LIMITS[tier].searches_per_month;
  await ensureUsage(db, organizationId);

  if (limit === -1) {
    await incrementSearchesRun(db, organizationId);
    return { allowed: true, tier };
  }

  const result = await atomicIncrementSearches(db, organizationId, limit);
  if (!result) {
    const usage = (await ensureUsage(db, organizationId)) as { searches_run?: number } | null;
    return {
      allowed: false,
      error: "search_quota_exceeded",
      limit,
      used: usage?.searches_run,
      tier,
    };
  }
  return { allowed: true, used: result.searches_run, limit, tier };
}

/**
 * Bound one message body — the single rule every write path (append, edit)
 * and the indexing estimate share, so what is charged is what is chunked.
 *
 * First, base64 file payloads (screenshots, PDFs) become a short note
 * ("[image not stored: PNG, 312 KB]", engram#386): an encoded screenshot
 * is not text, and counted as text it pushed the words after it past the
 * clip and was charged as dozens of chunks. Then the body is clipped to
 * MAX_MESSAGE_CONTENT_CHARS with a visible marker, so the reader sees the
 * memory was cut, not silently altered. Enormous single messages are
 * tool-output dumps (Claude Code), where the tail is the least useful part.
 */
export function boundContent(content: string): string {
  const text = stripBinaryPayloads(content);
  if (text.length <= MAX_MESSAGE_CONTENT_CHARS) return text;
  return (
    text.slice(0, MAX_MESSAGE_CONTENT_CHARS) +
    `\n\n…[truncated: message exceeded ${MAX_MESSAGE_CONTENT_CHARS.toLocaleString()} characters]`
  );
}

/**
 * How many chunks `messages` will embed when appended — computed with the
 * real chunker so the number charged is the number generated. Only order
 * and body length matter (windows of 5 messages, stride 3; oversized
 * bodies split), so the placeholder ids and sequences are irrelevant.
 * Bodies are bounded exactly the way append bounds them before chunking
 * (file payloads replaced, then clipped).
 */
export function estimateIndexingUnits(
  messages: ReadonlyArray<{ role: string; content: string }>,
): number {
  if (messages.length === 0) return 0;
  const pseudo: Message[] = messages.map((m, i) => ({
    id: `est_${i}`,
    conversation_id: "est",
    organization_id: "est",
    role: m.role as Message["role"],
    content: boundContent(m.content),
    tool_call_id: null,
    tool_name: null,
    sequence: i + 1,
    metadata: {},
    created_at: "",
  }));
  return chunkMessages(pseudo, { onWarn: () => {} }).length;
}

/**
 * Thrown by write paths that must refuse BEFORE changing anything when the
 * indexing budget is exhausted (message edit). Carries the check so the
 * route can answer 429 with limit/used/tier like the other gates.
 */
export class IndexingQuotaError extends Error {
  readonly result: TierCheckResult;
  constructor(result: TierCheckResult) {
    super(result.error ?? "indexing_quota_exceeded");
    this.name = "IndexingQuotaError";
    this.result = result;
  }
}

/**
 * Reserve `units` chunks of the period's indexing budget (engram#445,
 * #450) — the number of embeddings about to be generated, on append or on
 * an edit/delete re-index. Deleting frees storage but never refunds
 * indexing, so a save/delete loop cannot re-run the embedding model past
 * the budget; the only refund is an append that stored nothing
 * (releaseAppendCharges). Tiers without a budget just count.
 */
export async function checkAndTrackIndexing(
  db: D1Database,
  organizationId: string,
  tier: Tier,
  units: number,
  period: string = getCurrentPeriod(),
): Promise<TierCheckResult> {
  const limit = TIER_LIMITS[tier].chunks_indexed_per_month;
  if (units <= 0) return { allowed: true, limit, tier };
  await ensureUsage(db, organizationId, period);

  if (limit === -1) {
    await incrementChunksIndexed(db, organizationId, units, period);
    return { allowed: true, tier };
  }

  const result = await atomicIncrementChunksIndexed(db, organizationId, units, limit, period);
  if (!result) {
    const usage = (await ensureUsage(db, organizationId, period)) as { chunks_indexed?: number } | null;
    return {
      allowed: false,
      error: "indexing_quota_exceeded",
      limit,
      used: usage?.chunks_indexed,
      tier,
    };
  }
  return { allowed: true, used: result.chunks_indexed, limit, tier };
}

/**
 * Count one authenticated data-plane API request (engram#287).
 * Upsert-based, so no ensureUsage round trip is needed.
 */
export async function trackApiRequest(db: D1Database, organizationId: string) {
  await incrementApiRequests(db, generateId("usg"), organizationId);
}

/**
 * Effective lifetime storage limit for an org (engram#275). Team pools
 * per-seat: seat_limit × storage_messages. -1 = unlimited.
 */
export function storageLimitFor(tier: Tier, seatLimit?: number | null): number {
  const base = TIER_LIMITS[tier].storage_messages;
  if (base === -1) return -1;
  if (tier === "team") return base * Math.max(1, seatLimit ?? 1);
  return base;
}

/**
 * Atomically check the lifetime storage cap AND increment the counter.
 * Same race-safe reserve-then-write pattern as checkAndTrackMessages.
 * Appends reach it through reserveAppend, which gives the reservation
 * back (releaseAppendCharges) if a later gate refuses or the write fails.
 */
export async function checkAndTrackStorage(
  db: D1Database,
  organizationId: string,
  tier: Tier,
  messageCount: number,
): Promise<TierCheckResult> {
  let seatLimit: number | null = null;
  if (tier === "team") {
    const org = (await getOrganizationById(db, organizationId)) as {
      seat_limit?: number;
    } | null;
    seatLimit = org?.seat_limit ?? 1;
  }
  const limit = storageLimitFor(tier, seatLimit);

  if (limit === -1) {
    const r = await incrementStorage(db, organizationId, messageCount);
    return { allowed: true, used: r?.messages_stored_total, tier };
  }

  const result = await atomicIncrementStorage(db, organizationId, messageCount, limit);
  if (!result) {
    const row = await getStorageUsed(db, organizationId);
    return {
      allowed: false,
      error: "storage_full",
      limit,
      used: row?.messages_stored_total,
      tier,
    };
  }
  return { allowed: true, used: result.messages_stored_total, limit, tier };
}

/**
 * Give storage back when messages are deleted (freeing space is a feature:
 * memory is never expired, but the user can always make room). A refused
 * or failed append refunds through releaseAppendCharges instead.
 */
export async function releaseStorage(
  db: D1Database,
  organizationId: string,
  messageCount: number,
) {
  if (messageCount <= 0) return;
  await decrementStorage(db, organizationId, messageCount);
}

/**
 * Everything one append has been charged (engram#591): what a refusal or
 * a failed write must give back. Every append surface charges through
 * reserveAppend and refunds through releaseAppendCharges, so the order of
 * the gates and what each one refunds live in one place.
 */
export interface AppendCharges {
  /** The month the per-period counters were charged in. */
  readonly period: string;
  /** Messages reserved against the lifetime storage cap. */
  storage: number;
  /** Messages counted against the month's message budget. */
  messages: number;
  /** Chunks counted against the month's indexing budget. */
  chunks: number;
}

/** The gate that refused an append; nothing it charged is still held. */
export type AppendGate = "storage" | "messages" | "indexing";

export type AppendReservation =
  | {
      allowed: true;
      charges: AppendCharges;
      storage: TierCheckResult;
      messages: TierCheckResult;
      indexing: TierCheckResult;
    }
  | { allowed: false; gate: AppendGate; check: TierCheckResult };

type ReleaseLog = Pick<Console, "error">;

/**
 * Give back everything `charges` holds, then zero it so a second call
 * refunds nothing. Only for an append that stored nothing — refused by a
 * later gate or check, or its write threw (appendMessages throws only
 * before it commits) — so nothing was embedded either, and refunding the
 * indexing charge is not the save/delete loophole the monotonic counter
 * closes: a delete still never refunds it.
 *
 * Never throws. Each counter is released on its own; one that fails is
 * logged and left charged, so an org can end up over-charged by a failed
 * refund but never under-charged, and the caller's own answer (a refusal,
 * or the original error) is never replaced by a refund error.
 */
export async function releaseAppendCharges(
  db: D1Database,
  organizationId: string,
  charges: AppendCharges,
  log: ReleaseLog = console,
): Promise<void> {
  const { storage, messages, chunks, period } = charges;
  charges.storage = 0;
  charges.messages = 0;
  charges.chunks = 0;
  const steps: Array<[string, number, () => Promise<unknown>]> = [
    ["storage", storage, () => decrementStorage(db, organizationId, storage)],
    ["messages", messages, () => releaseMessagesStored(db, organizationId, messages, period)],
    ["indexing", chunks, () => releaseChunksIndexed(db, organizationId, chunks, period)],
  ];
  for (const [name, amount, release] of steps) {
    if (amount <= 0) continue;
    try {
      await release();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[append] could not refund ${amount} ${name} for ${organizationId}: ${msg}`);
    }
  }
}

/**
 * Charge one append against every gate, in order (engram#275, #445/#450):
 * lifetime storage (atomically reserved), the month's message budget (a
 * velocity guard on paid tiers; free has none), then the month's indexing
 * budget, in the unit that costs money — chunks embedded, computed with
 * the real chunker. A refusal gives back what the gates before it took
 * and names the gate; nothing stays charged for a refused append. On
 * success the caller owns `charges` and must hand them to
 * releaseAppendCharges if anything before the commit refuses or throws.
 *
 * All per-period statements use one captured period, so an append that
 * straddles midnight UTC on the 1st charges, and refunds, one month.
 */
export async function reserveAppend(
  db: D1Database,
  organizationId: string,
  tier: Tier,
  messages: ReadonlyArray<{ role: string; content: string }>,
): Promise<AppendReservation> {
  const count = messages.length;
  const charges: AppendCharges = {
    period: getCurrentPeriod(),
    storage: 0,
    messages: 0,
    chunks: 0,
  };

  const storage = await checkAndTrackStorage(db, organizationId, tier, count);
  if (!storage.allowed) return { allowed: false, gate: "storage", check: storage };
  charges.storage = count;

  try {
    const monthly = await checkAndTrackMessages(db, organizationId, tier, count, charges.period);
    if (!monthly.allowed) {
      await releaseAppendCharges(db, organizationId, charges);
      return { allowed: false, gate: "messages", check: monthly };
    }
    charges.messages = count;

    const units = estimateIndexingUnits(messages);
    const indexing = await checkAndTrackIndexing(db, organizationId, tier, units, charges.period);
    if (!indexing.allowed) {
      await releaseAppendCharges(db, organizationId, charges);
      return { allowed: false, gate: "indexing", check: indexing };
    }
    charges.chunks = Math.max(0, units);

    return { allowed: true, charges, storage, messages: monthly, indexing };
  } catch (err) {
    // A gate threw (D1 trouble). Refund only what is known to be charged:
    // a charge whose statement may or may not have landed stays charged.
    await releaseAppendCharges(db, organizationId, charges);
    throw err;
  }
}

export function checkConversationLimit(
  tier: Tier,
  currentCount: number
): TierCheckResult {
  const limits = TIER_LIMITS[tier];

  if (limits.conversations === -1) {
    return { allowed: true };
  }

  if (currentCount >= limits.conversations) {
    return {
      allowed: false,
      error: "conversation_limit_exceeded",
      limit: limits.conversations,
      used: currentCount,
      tier,
    };
  }

  return { allowed: true };
}

export function checkFeatureAccess(tier: Tier, feature: "webhooks" | "usage_dashboard"): boolean {
  return TIER_LIMITS[tier][feature];
}
