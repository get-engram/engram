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
  // Shared secret between engram-web and the worker. engram-web's
  // Next.js server action sends this as a Bearer on /signup so random
  // internet traffic can't mint API keys against arbitrary emails.
  // Temporary until stage 2 (worker verifies Supabase JWTs via JWKS).
  WORKER_SIGNUP_SECRET: string;
}

export interface AuthContext {
  organizationId: string;
  apiKeyId: string;
  tier: "free" | "pro" | "team" | "enterprise";
}
