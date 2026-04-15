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
  // Supabase JWT secret — used to verify access tokens from engram-web.
  // The dashboard sends the user's Supabase access token as a Bearer on
  // /signup; the worker verifies the HS256 signature and extracts the
  // user's email from the claims.
  SUPABASE_JWT_SECRET: string;
}

export interface AuthContext {
  organizationId: string;
  apiKeyId: string;
  tier: "free" | "pro" | "team" | "enterprise";
}
