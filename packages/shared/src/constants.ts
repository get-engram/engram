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
}> = {
  free: {
    messages_per_month: 1_000,
    conversations: 5,
    seats: 1,
    api_keys: 1,
    webhooks: false,
    usage_dashboard: false,
  },
  pro: {
    messages_per_month: 100_000,
    conversations: -1, // unlimited
    seats: 1,
    api_keys: 1,
    webhooks: false,
    usage_dashboard: false,
  },
  team: {
    messages_per_month: 500_000,
    conversations: -1,
    seats: 5,
    api_keys: 5,
    webhooks: true,
    usage_dashboard: true,
  },
  enterprise: {
    messages_per_month: -1, // unlimited
    conversations: -1,
    seats: -1,
    api_keys: -1,
    webhooks: true,
    usage_dashboard: true,
  },
};
