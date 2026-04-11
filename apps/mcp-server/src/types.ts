export interface Env {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
}

export interface AuthContext {
  organizationId: string;
  apiKeyId: string;
  tier: "free" | "pro" | "team" | "enterprise";
}
