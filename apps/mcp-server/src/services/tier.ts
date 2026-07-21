import { TIER_LIMITS, type Tier } from "@getengram/shared";
import {
  getOrCreateUsage,
  atomicIncrementMessages,
  incrementMessagesStored,
  incrementSearchesRun,
  incrementApiRequests,
  atomicIncrementStorage,
  incrementStorage,
  decrementStorage,
  getStorageUsed,
  getOrganizationById,
} from "@getengram/db";
import { generateId } from "@getengram/shared";

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
 * Increment searches_run counter. Ensures usage row exists first.
 */
export async function trackSearchRun(
  db: D1Database,
  organizationId: string
) {
  await ensureUsage(db, organizationId);
  await incrementSearchesRun(db, organizationId);
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
