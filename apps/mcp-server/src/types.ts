export interface Env {
  DB: D1Database;
  CONTENT: R2Bucket;
  /** Chunk text copies (engram#384), keyed `<conversation_id>/<chunk_id>`.
   *  See services/chunk-store.ts for the stages. */
  CHUNKS: R2Bucket;
  VECTORIZE: VectorizeIndex;
  SELF: Fetcher;
  DRAINER: DurableObjectNamespace;
  /** Copies/verifies chunk text into CHUNKS (engram#384). */
  CHUNK_MOVER: DurableObjectNamespace;
  AI: Ai;
  // Stripe (wrangler secrets)
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRICE_ID_PRO: string;
  STRIPE_PRICE_ID_TEAM: string;
  STRIPE_PRICE_ID_STUDENT: string;
  /** Team at academic pricing — used when the org has a verified university email. */
  STRIPE_PRICE_ID_EDU_TEAM: string;
  APP_URL: string; // e.g. "https://getengram.app"
  /** The owner's admin bearer for this worker (the /admin routes and admin
   *  API calls), and nothing else once the secrets below are set
   *  (services/secrets.ts, engram#456). */
  ADMIN_SECRET: string;
  /** The bearer the worker shows engram-web's email and report routes.
   *  ADMIN_SECRET stands in until it is set. */
  INTERNAL_CRON_SECRET?: string;
  /** Signs the unsubscribe links in lifecycle emails. ADMIN_SECRET stands in
   *  until it is set. */
  UNSUBSCRIBE_HMAC_KEY?: string;
  /** The signing key before the last change: links already mailed keep
   *  working. Removed 60 days after the change. */
  UNSUBSCRIBE_HMAC_KEY_PREVIOUS?: string;
  /** "1" pauses all writes for a maintenance window. Set and cleared with
   *  `wrangler secret put/delete WRITES_FROZEN` — takes effect on new
   *  requests without a redeploy, so a window can be opened and closed in
   *  seconds. Reads are unaffected. */
  WRITES_FROZEN?: string;
  // Supabase JWT secret — used to verify access tokens from engram-web.
  // The dashboard sends the user's Supabase access token as a Bearer on
  // /signup; the worker verifies the HS256 signature and extracts the
  // user's email from the claims.
  SUPABASE_JWT_SECRET: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
}

/** Least-privilege scopes for API keys (engram#69). */
export type Scope = "read" | "write" | "search" | "delete";

export interface AuthContext {
  organizationId: string;
  apiKeyId: string;
  tier: "free" | "pro" | "team" | "enterprise";
  /** Scopes granted to the calling key: subset of read/write/search/delete. */
  scopes: Scope[];
  /** True when authenticated via ADMIN_SECRET — grants cross-org visibility. */
  isAdmin?: boolean;
  /** Seat the API key is bound to (engram#264) — null for owner keys and
   * OAuth connections. Drives private-memory visibility. */
  seatId?: string | null;
}
