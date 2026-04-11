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
}

export interface AuthContext {
  organizationId: string;
  apiKeyId: string;
  tier: "free" | "pro" | "team" | "enterprise";
}
