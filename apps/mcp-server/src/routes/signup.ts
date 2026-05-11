import { Hono } from "hono";
import {
  generateId,
  generateApiKeyRaw,
  hashApiKey,
} from "@getengram/shared";
import {
  getOrganizationByEmail,
  getOrganizationById,
  insertOrganization,
  insertOrganizationWithEmail,
  insertApiKey,
  setOrganizationEmail,
} from "@getengram/db";
import type { Env } from "../types.js";
import { verifySupabaseJwt } from "../utils/jwt.js";

type HonoEnv = { Bindings: Env };

const signup = new Hono<HonoEnv>();

// POST /signup — mint (or attach) an API key for the authenticated user.
//
// Auth: Supabase JWT Bearer. The Next.js server action on engram-web
// sends the user's Supabase access token. We verify the HS256 signature
// using the shared JWT secret and extract the user's email from the
// token claims — no request body needed for identity.
//
// Behavior is idempotent-ish: if an org already exists for this email
// (either from a prior sign-in or from the pre-Supabase flow), we
// attach a fresh API key to the existing org and return it. We never
// return the user's previous key — it's hashed.
signup.post("/", async (c) => {
  const jwtSecret = c.env.SUPABASE_JWT_SECRET;
  if (!jwtSecret) {
    return c.json(
      { error: "server_misconfigured", message: "SUPABASE_JWT_SECRET is not set" },
      500,
    );
  }

  // Extract and verify the Supabase access token
  const authHeader = c.req.header("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) {
    return c.json({ error: "unauthorized", message: "Missing Bearer token" }, 401);
  }

  let claims;
  try {
    claims = await verifySupabaseJwt(token, jwtSecret, c.env.SUPABASE_URL);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid token";
    return c.json({ error: "unauthorized", message }, 401);
  }

  const email = claims.email;
  if (!email) {
    return c.json(
      { error: "invalid_token", message: "JWT does not contain an email claim" },
      400,
    );
  }

  // Accept optional plan from body (defaults to free)
  const body = await c.req.json().catch(() => ({}));
  const plan = body.plan === "pro" ? "pro" : "free";

  // Find-or-create the org
  let orgId: string;
  let created: boolean;
  const existing = (await getOrganizationByEmail(c.env.DB, email)) as
    | { id: string }
    | null;
  if (existing) {
    orgId = existing.id;
    created = false;
  } else {
    orgId = generateId("org");
    const orgName = email.split("@")[0];
    await insertOrganizationWithEmail(c.env.DB, orgId, orgName, email);
    created = true;
  }

  // Always mint a fresh API key. The caller cannot recover the prior
  // key (it's hashed at rest), so callers rely on this being the
  // canonical way to bootstrap server-side credentials for a user.
  const keyId = generateId("key");
  const { raw, prefix } = generateApiKeyRaw();
  const keyHash = await hashApiKey(raw);
  await insertApiKey(c.env.DB, keyId, orgId, keyHash, prefix, "Default");

  return c.json(
    {
      organization_id: orgId,
      api_key: raw,
      key_prefix: prefix,
      plan,
      created,
    },
    created ? 201 : 200,
  );
});

// POST /signup/anonymous — mint an org + API key with no auth required.
// This powers `engram signup` from the CLI, letting AI agents self-provision
// accounts without any human interaction.
signup.post("/anonymous", async (c) => {
  const orgId = generateId("org");
  const orgName = `anon-${orgId.slice(4, 12)}`;
  await insertOrganization(c.env.DB, orgId, orgName);

  const keyId = generateId("key");
  const { raw, prefix } = generateApiKeyRaw();
  const keyHash = await hashApiKey(raw);
  await insertApiKey(c.env.DB, keyId, orgId, keyHash, prefix, "Default");

  return c.json(
    {
      organization_id: orgId,
      api_key: raw,
      key_prefix: prefix,
      plan: "free",
      created: true,
    },
    201,
  );
});

// POST /signup/link — attach an email to an anonymous org.
// Auth: Engram API key Bearer. The CLI sends the user's API key.
// Body: { email: string }
//
// This updates the organization's email field so the account can be
// found via email-based login later.
signup.post("/link", async (c) => {
  // Verify the API key manually (this route is under /signup, not /api/*)
  const authHeader = c.req.header("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token || !token.startsWith("engram_sk_live_")) {
    return c.json({ error: "unauthorized", message: "Missing or invalid API key" }, 401);
  }

  // Hash and look up the key
  const { hashApiKey } = await import("@getengram/shared");
  const keyHash = await hashApiKey(token);
  const keyRow = await c.env.DB.prepare(
    "SELECT k.organization_id FROM api_keys k WHERE k.key_hash = ?",
  )
    .bind(keyHash)
    .first<{ organization_id: string }>();

  if (!keyRow) {
    return c.json({ error: "unauthorized", message: "Invalid API key" }, 401);
  }

  const body = await c.req.json<{ email?: string }>().catch(() => ({}));
  const email = body.email?.trim();
  if (!email || !email.includes("@")) {
    return c.json({ error: "invalid_email", message: "A valid email is required" }, 400);
  }

  // Check if another org already uses this email
  const existing = await getOrganizationByEmail(c.env.DB, email);
  if (existing && (existing as { id: string }).id !== keyRow.organization_id) {
    return c.json(
      { error: "email_taken", message: "This email is already linked to another account" },
      409,
    );
  }

  await setOrganizationEmail(c.env.DB, keyRow.organization_id, email);

  return c.json({ linked: true, organization_id: keyRow.organization_id, email });
});

export { signup };
