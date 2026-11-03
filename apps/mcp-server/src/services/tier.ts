import {
  TIER_LIMITS,
  MAX_MESSAGE_CONTENT_CHARS,
  chunkMessages,
  generateId,
  type Tier,
  type Message,
} from "@getengram/shared";
import {
  getOrCreateUsage,
  atomicIncrementMessages,
  incrementMessagesStored,
  incrementSearchesRun,
  atomicIncrementSearches,
  incrementChunksIndexed,
  atomicIncrementChunksIndexed,
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
 * Ensure a usage row exists for the current period and return it.
 * Single D1 round trip via INSERT ... ON CONFLICT ... RETURNING.
 */
async function ensureUsage(db: D1Database, organizationId: string) {
  const id = generateId("usg");
  return getOrCreateUsage(db, id, organizationId);
}

/**
 * Atomically check the message limit AND increment the counter in one
 * operation. Prevents race conditions where concurrent requests both
 * pass the check but together exceed the limit.
 *
 * For unlimited tiers, skips the atomic check and just increments.
 */
export async function checkAndTrackMessages(
  db: D1Database,
  organizationId: string,
  tier: Tier,
  messageCount: number,
): Promise<TierCheckResult> {
  const limits = TIER_LIMITS[tier];

  // Ensure usage row exists
  await ensureUsage(db, organizationId);

  // Unlimited tier — just increment, no limit check
  if (limits.messages_per_month === -1) {
    await incrementMessagesStored(db, organizationId, messageCount);
    return { allowed: true };
  }

  // Atomic: increment only if within limit
  const result = await atomicIncrementMessages(
    db,
    organizationId,
    messageCount,
    limits.messages_per_month,
  );

  if (!result) {
    // Limit would be exceeded — fetch current usage for error message
    const usage = await ensureUsage(db, organizationId);
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
 * Clip one message body to MAX_MESSAGE_CONTENT_CHARS with a visible marker
 * — the single rule every write path (append, edit) and the indexing
 * estimate share, so what is charged is what is chunked. The marker keeps
 * the clip honest: the reader sees the memory was cut, not silently
 * altered. Enormous single messages are tool-output dumps (Claude Code),
 * where the tail is the least useful part.
 */
export function boundContent(content: string): string {
  if (content.length <= MAX_MESSAGE_CONTENT_CHARS) return content;
  return (
    content.slice(0, MAX_MESSAGE_CONTENT_CHARS) +
    `\n\n…[truncated: message exceeded ${MAX_MESSAGE_CONTENT_CHARS.toLocaleString()} characters]`
  );
}

/**
 * How many chunks `messages` will embed when appended — computed with the
 * real chunker so the number charged is the number generated. Only order
 * and body length matter (windows of 5 messages, stride 3; oversized
 * bodies split), so the placeholder ids and sequences are irrelevant.
 * Bodies are clipped exactly the way append clips them before chunking.
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
 * an edit/delete re-index. The counter is monotonic: deleting frees
 * storage but never refunds indexing, so a save/delete loop cannot re-run
 * the embedding model past the budget. Tiers without a budget just count.
 */
export async function checkAndTrackIndexing(
  db: D1Database,
  organizationId: string,
  tier: Tier,
  units: number,
): Promise<TierCheckResult> {
  const limit = TIER_LIMITS[tier].chunks_indexed_per_month;
  if (units <= 0) return { allowed: true, limit, tier };
  await ensureUsage(db, organizationId);

  if (limit === -1) {
    await incrementChunksIndexed(db, organizationId, units);
    return { allowed: true, tier };
  }

  const result = await atomicIncrementChunksIndexed(db, organizationId, units, limit);
  if (!result) {
    const usage = (await ensureUsage(db, organizationId)) as { chunks_indexed?: number } | null;
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
 * Same race-safe reserve-then-write pattern as checkAndTrackMessages;
 * callers must releaseStorage() if the write that follows fails.
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
 * Give reserved storage back — when the monthly gate rejects after the
 * storage reservation, when the write itself fails, or when a
 * conversation is deleted (freeing space is a feature: memory is never
 * expired, but the user can always make room).
 */
export async function releaseStorage(
  db: D1Database,
  organizationId: string,
  messageCount: number,
) {
  if (messageCount <= 0) return;
  await decrementStorage(db, organizationId, messageCount);
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
