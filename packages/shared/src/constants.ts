export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
export const EMBEDDING_DIMENSIONS = 768;
export const VECTORIZE_INDEX_NAME = "engram-vectors";
export const CHUNK_WINDOW_SIZE = 5;
export const CHUNK_STRIDE = 3;
export const MAX_MESSAGES_PER_APPEND = 200;
export const DEFAULT_SEARCH_LIMIT = 10;
export const DEFAULT_MESSAGE_LIMIT = 100;
export const DEFAULT_CONVERSATION_LIMIT = 20;

// Tier definitions
export type Tier = "free" | "pro" | "team" | "enterprise";

export const TIER_LIMITS: Record<Tier, {
  messages_per_month: number;
  conversations: number;
  seats: number;
  api_keys: number;
  webhooks: boolean;
  usage_dashboard: boolean;
  retention_days: number;
}> = {
  free: {
    messages_per_month: 1_000,
    conversations: -1,
    seats: 1,
    api_keys: -1, // unlimited — usage caps are the billing gate, not key count
    webhooks: false,
    usage_dashboard: false,
    // Rolling memory window (engram#252): conversations not updated within
    // this many days are ARCHIVED — hidden from search/recall, never deleted.
    // Upgrading unlocks them instantly. Export is always available.
    retention_days: 30,
  },
  pro: {
    messages_per_month: 100_000,
    conversations: -1,
    seats: 1,
    api_keys: -1,
    webhooks: false,
    usage_dashboard: false,
    retention_days: -1, // permanent
  },
  team: {
    messages_per_month: 500_000,
    conversations: -1,
    seats: -1, // dynamic — enforced via org.seat_limit from Stripe quantity
    api_keys: -1,
    webhooks: true,
    usage_dashboard: true,
    retention_days: -1, // permanent
  },
  enterprise: {
    messages_per_month: -1, // unlimited
    conversations: -1,
    seats: -1,
    api_keys: -1,
    webhooks: true,
    usage_dashboard: true,
    retention_days: -1, // permanent
  },
};

// Free-tier memory-window enforcement starts after a 14-day public notice
// (announced 2026-07-14; engram#252). Before this instant the window is not
// applied, so existing free orgs get the promised grace period.
export const RETENTION_ENFORCEMENT_DATE = "2026-07-28T00:00:00Z";
