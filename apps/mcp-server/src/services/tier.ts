import { TIER_LIMITS, type Tier } from "@getengram/shared";
import { getUsage, getOrCreateUsage, incrementMessagesStored, incrementSearchesRun } from "@getengram/db";
import { generateId } from "@getengram/shared";

export interface TierCheckResult {
  allowed: boolean;
  error?: string;
  limit?: number;
  used?: number;
  tier?: Tier;
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

  // Ensure usage row exists for current period
  let usage = await getUsage(db, organizationId);
  if (!usage) {
    const id = generateId("usg");
    usage = await getOrCreateUsage(db, id, organizationId);
  }

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

export async function trackMessagesStored(
  db: D1Database,
  organizationId: string,
  count: number
) {
  // Ensure usage row exists
  let usage = await getUsage(db, organizationId);
  if (!usage) {
    const id = generateId("usg");
    await getOrCreateUsage(db, id, organizationId);
  }
  await incrementMessagesStored(db, organizationId, count);
}

export async function trackSearchRun(
  db: D1Database,
  organizationId: string
) {
  let usage = await getUsage(db, organizationId);
  if (!usage) {
    const id = generateId("usg");
    await getOrCreateUsage(db, id, organizationId);
  }
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
