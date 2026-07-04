export interface Env {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  // Stripe (wrangler secrets)
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRICE_ID_PRO: string;
  STRIPE_PRICE_ID_TEAM: string;
  APP_URL: string; // e.g. "https://getengram.app"
  ADMIN_SECRET: string; // wrangler secret for /api/admin/* routes
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
}
