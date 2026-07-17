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
  /**
   * Lifetime message storage (engram#275) — the primary billing gate,
   * Gmail-style: memory fills up, nothing ever expires or is deleted.
   * Deleting conversations frees space; upgrading raises the ceiling.
   * For team, this is PER SEAT (pooled: seat_limit × storage_messages).
   * -1 = unlimited.
   */
  storage_messages: number;
  /**
   * Monthly write velocity. No longer the marketed gate — kept on paid
   * tiers purely as an abuse guard; free relies on the storage cap.
   * -1 = unlimited.
   */
  messages_per_month: number;
  conversations: number;
  seats: number;
  api_keys: number;
  webhooks: boolean;
  usage_dashboard: boolean;
}> = {
  free: {
    storage_messages: 10_000,
    messages_per_month: -1, // replaced by the storage cap — full speed until full
    conversations: -1,
    seats: 1,
    api_keys: -1, // unlimited — usage caps are the billing gate, not key count
    webhooks: false,
    usage_dashboard: false,
  },
  pro: {
    storage_messages: 1_000_000,
    messages_per_month: 100_000, // abuse guard only
    conversations: -1,
    seats: 1,
    api_keys: -1,
    webhooks: false,
    usage_dashboard: false,
  },
  team: {
    storage_messages: 1_000_000, // per seat, pooled across the org
    messages_per_month: 500_000, // abuse guard only
    conversations: -1,
    seats: -1, // dynamic — enforced via org.seat_limit from Stripe quantity
    api_keys: -1,
    webhooks: true,
    usage_dashboard: true,
  },
  enterprise: {
    storage_messages: -1, // unlimited
    messages_per_month: -1, // unlimited
    conversations: -1,
    seats: -1,
    api_keys: -1,
    webhooks: true,
    usage_dashboard: true,
  },
};
