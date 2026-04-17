import { TIER_LIMITS, type Tier } from "@getengram/shared";
import { getOrCreateUsage, incrementMessagesStored, incrementSearchesRun } from "@getengram/db";
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

export async function checkMessageLimit(
  db: D1Database,
  organizationId: string,
  tier: Tier,
  messageCount: number
): Promise<TierCheckResult> {
  const limits = TIER_LIMITS[tier];

  // Unlimited
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
