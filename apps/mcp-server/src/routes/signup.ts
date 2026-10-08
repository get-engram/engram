import { Hono } from "hono";
import { requestCountry } from "../utils/geo.js";
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
  getApiKeyCount,
  setOrganizationEmail,
  getApiKeyWithOrg,
} from "@getengram/db";
import { TIER_LIMITS, type Tier } from "@getengram/shared";
import type { Env, AuthContext } from "../types.js";
import { verifySupabaseJwt } from "../utils/jwt.js";
import { ipThrottle } from "../middleware/ip-throttle.js";
import { hasScope, parseScopes } from "../mcp/scopes.js";
import { audit } from "../services/audit.js";

/**
 * Authenticate an Engram API key on a /signup/* route (engram#475 audit).
 *
 * These routes are mounted outside authMiddleware, and each used to run its
 * own `SELECT organization_id FROM api_keys WHERE key_hash = ?` — with no
 * revoked_at or expires_at predicate. A revoked key could therefore still
 * re-point an org's email and mint a web login for it: post-revocation
 * account takeover. getApiKeyWithOrg is the one lookup that enforces
 * revocation; nothing on this server may look a key up any other way.
 */
async function authenticateApiKey(
  db: D1Database,
  authHeader: string,
): Promise<AuthContext | null> {
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token || !token.startsWith("engram_sk_live_")) return null;
  const row = await getApiKeyWithOrg(db, await hashApiKey(token));
  if (!row) return null;
  return {
    organizationId: row.organization_id,
    apiKeyId: row.key_id,
    tier: (row.tier ?? "free") as AuthContext["tier"],
    scopes: parseScopes(row.scopes),
    seatId: row.seat_id ?? null,
  };
}

/**
 * May a never-before-seen identity attach itself to this existing org just
 * by presenting its email? (engram#475 audit, critical #1)
 *
 * No. The Supabase project auto-confirms every address
 * (mailer_autoconfirm), so a JWT's email proves nothing about inbox control
 * — anyone can sign up as anyone. Binding by email let an attacker claim any
 * unbound org with memories in it (716 at the time of the audit). An org
 * with nothing in it has nothing to steal, so a fresh identity may bind it;
 * an org with data requires proof of inbox control first. Until the
 * self-service claim flow ships, that proof is a support request — the same
 * path the one real case (Oct 2026) already took.
 */
export function requiresClaim(org: { messages_stored_total?: number | null }): boolean {
  return (org.messages_stored_total ?? 0) > 0;
}

const WELCOME_MESSAGE = `Welcome to Engram — your AI's long-term memory.

Here's how to get started:

1. **Save a conversation**: After a good chat, say "remember this" or "save this conversation." Your AI will store it in Engram.

2. **Recall later**: In any future session, ask "what do you remember about [topic]?" Your AI will search your stored conversations and bring back the context.

3. **Works everywhere**: Engram works across ChatGPT, Claude Code, Cursor, and any MCP-compatible tool. Save something in one, recall it in another.

That's it. Three steps. Your AI now has memory that persists across sessions, projects, and tools.

Try it now — have a conversation about something you're working on, then say "remember this." Tomorrow, ask about it and watch the magic happen.`;

const WELCOME_TAGS = ["welcome", "getting-started"];

/**
 * Seed the welcome conversation.
 *
 * This writes the conversation and message rows directly rather than going
 * through createConversation/appendMessages, so it has to reproduce the
 * invariants those maintain by hand: the denormalized org counters
 * (engram#41) and the conversation_tags junction index (engram#42).
 *
 * It previously maintained none of them, which left every org that ever
 * signed up off by exactly one message and one conversation —
 * `messages_stored_total` is the lifetime storage cap (engram#275), i.e.
 * the billing gate, so it silently under-enforced and disagreed with what
 * memory_status reported. Everything is in one batch so the counters can
 * never diverge from the rows again.
 */
export async function seedWelcomeConversation(db: D1Database, orgId: string): Promise<void> {
  const convId = generateId("conv");
  const msgId = generateId("msg");
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(
      "INSERT INTO conversations (id, organization_id, title, agent_id, tags, metadata, message_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)"
    ).bind(convId, orgId, "Welcome to Engram", "engram", JSON.stringify(WELCOME_TAGS), '{"system":true,"type":"welcome"}', now, now),
    db.prepare(
      "INSERT INTO messages (id, conversation_id, organization_id, role, content, sequence, metadata, created_at) VALUES (?, ?, ?, 'assistant', ?, 0, '{}', ?)"
    ).bind(msgId, convId, orgId, WELCOME_MESSAGE, now),
    // No cap check: this is signup, the org is empty, and one message fits
    // inside every tier's ceiling.
    db.prepare(
      "UPDATE organizations SET conversation_count = conversation_count + 1, messages_stored_total = messages_stored_total + 1 WHERE id = ?"
    ).bind(orgId),
    ...WELCOME_TAGS.map((tag) =>
      db.prepare(
        "INSERT OR IGNORE INTO conversation_tags (conversation_id, organization_id, tag) VALUES (?, ?, ?)"
      ).bind(convId, orgId, tag),
    ),
  ]);
}

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

  // Accept optional plan and referral source from body
  const body = await c.req.json().catch(() => ({}));
  const plan = body.plan === "pro" ? "pro" : "free";
  const ref = body.ref || body.referral_source || null;

  // Find-or-create the org
  let orgId: string;
  let created: boolean;
  const existing = (await getOrganizationByEmail(c.env.DB, email)) as
    | { id: string; messages_stored_total?: number | null }
    | null;
  if (existing) {
    if (requiresClaim(existing as { messages_stored_total?: number | null })) {
      await audit(c.env.DB, existing.id, null, "signup.claim_required", "organization", existing.id, {
        sub: claims.sub,
      });
      return c.json(
        {
          error: "claim_required",
          message:
            "An Engram account with saved memories already exists for this email address. " +
            "To link this sign-in to it, email hello@getengram.app from that address and " +
            "we'll connect it — nothing in the account is affected.",
        },
        403,
      );
    }
    orgId = existing.id;
    created = false;
  } else {
    orgId = generateId("org");
    const orgName = email.split("@")[0];
    await insertOrganizationWithEmail(c.env.DB, orgId, orgName, email, ref, requestCountry(c.req.raw));
    await seedWelcomeConversation(c.env.DB, orgId);
    created = true;
  }

  // Always mint a key during the signup/provisioning flow. This endpoint
  // is only called once per Supabase user (the dashboard caches the
  // profile row). Manual key limits are enforced in /api/keys instead.
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
// accounts without any human interaction. Because it is unauthenticated AND
// creates rows (org + key + welcome conversation), it is the sharpest abuse
// surface on the server: throttle it per IP so it can't be looped into
// thousands of orgs. Generous enough for real CLI use (a person provisions a
// handful of accounts), tight enough to stop a mint loop.
signup.post("/anonymous", ipThrottle({ limit: 10, windowMs: 60_000, bucket: "signup-anon" }), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const ref = body.ref || body.referral_source || "cli";
  const orgId = generateId("org");
  const orgName = `anon-${orgId.slice(4, 12)}`;
  await insertOrganization(c.env.DB, orgId, orgName, ref, requestCountry(c.req.raw));
  await seedWelcomeConversation(c.env.DB, orgId);

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
  const auth = await authenticateApiKey(c.env.DB, c.req.header("authorization") ?? "");
  if (!auth) {
    return c.json({ error: "unauthorized", message: "Missing, invalid, or revoked API key" }, 401);
  }
  // Re-pointing the org's email is a write — a read-only key may not do it.
  if (!hasScope(auth, "write")) return c.json({ error: "insufficient_scope", message: "This action requires the 'write' scope." }, 403);
  const keyRow = { organization_id: auth.organizationId };

  const body = await c.req.json<{ email?: string }>().catch(() => ({} as { email?: string }));
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

  const before = (await getOrganizationById(c.env.DB, keyRow.organization_id)) as
    | { email: string | null }
    | null;
  await setOrganizationEmail(c.env.DB, keyRow.organization_id, email);
  // Old and new value both recorded: the one audit entry that previously
  // covered an email change held neither, which is why the Oct 2026 lockout
  // had to be reconstructed from timestamps.
  await audit(c.env.DB, keyRow.organization_id, auth.apiKeyId, "org.email_link", "organization", keyRow.organization_id, {
    from: before?.email ?? null,
    to: email,
  });

  return c.json({ linked: true, organization_id: keyRow.organization_id, email });
});

// POST /signup/set-password — give a CLI-born account a web login.
// Auth: Engram API key Bearer. Body: { password }. Requires the org to
// already have an email (engram link). Creates the Supabase user through
// the same public signup endpoint the web form uses, so the email-based
// org lookup in /signup logs the browser session into THIS org. If
// Supabase requires email confirmation, the password works after the
// user clicks the verification link.
signup.post("/set-password", async (c) => {
  const auth = await authenticateApiKey(c.env.DB, c.req.header("authorization") ?? "");
  if (!auth) {
    return c.json({ error: "unauthorized", message: "Missing, invalid, or revoked API key" }, 401);
  }
  if (!hasScope(auth, "write")) return c.json({ error: "insufficient_scope", message: "This action requires the 'write' scope." }, 403);
  const keyRow = { organization_id: auth.organizationId };
  await audit(c.env.DB, auth.organizationId, auth.apiKeyId, "account.set_password", "organization", auth.organizationId);

  const org = await c.env.DB.prepare(
    "SELECT email FROM organizations WHERE id = ?",
  )
    .bind(keyRow.organization_id)
    .first<{ email: string | null }>();
  if (!org?.email) {
    return c.json(
      { error: "no_email", message: "Link an email first: engram link <email>" },
      400,
    );
  }

  const body = await c.req
    .json<{ password?: string }>()
    .catch(() => ({}) as { password?: string });
  const password = body.password ?? "";
  if (password.length < 8) {
    return c.json(
      { error: "weak_password", message: "Password must be at least 8 characters" },
      400,
    );
  }

  const supabaseUrl = c.env.SUPABASE_URL;
  const supabaseAnonKey = c.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    return c.json(
      { error: "server_misconfigured", message: "Supabase is not configured" },
      500,
    );
  }

  const res = await fetch(`${supabaseUrl}/auth/v1/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: supabaseAnonKey },
    body: JSON.stringify({ email: org.email, password }),
  });
  const j = (await res.json().catch(() => ({}))) as {
    msg?: string;
    error_description?: string;
    session?: unknown;
    user?: { identities?: unknown[] };
  };
  if (!res.ok) {
    const msg = j.msg || j.error_description || "";
    if (/already registered/i.test(msg)) {
      return c.json(
        {
          error: "password_exists",
          message:
            "This email already has a web login. Sign in at getengram.app/login (or use password reset there).",
        },
        409,
      );
    }
    return c.json({ error: "auth_failed", message: msg || `Supabase error ${res.status}` }, 400);
  }
  // Supabase obfuscates existing users when confirmations are on: 200 with
  // an identity-less user instead of an error.
  if (j.user && Array.isArray(j.user.identities) && j.user.identities.length === 0) {
    return c.json(
      {
        error: "password_exists",
        message:
          "This email already has a web login. Sign in at getengram.app/login (or use password reset there).",
      },
      409,
    );
  }

  return c.json({ ok: true, confirmation_required: !j.session, email: org.email });
});

// POST /signup/login — authenticate with email + password, return API key.
// Handles Supabase auth server-side so the CLI doesn't need credentials.
signup.post("/login", async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>().catch(() => ({} as Record<string, string>));
  const email = body.email?.trim();
  const password = body.password;

  if (!email || !password) {
    return c.json({ error: "invalid_request", message: "Email and password are required" }, 400);
  }

  const supabaseUrl = c.env.SUPABASE_URL;
  const supabaseAnonKey = c.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    return c.json({ error: "server_misconfigured", message: "Supabase is not configured" }, 500);
  }

  // Authenticate with Supabase
  const authRes = await fetch(
    `${supabaseUrl}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: supabaseAnonKey,
      },
      body: JSON.stringify({ email, password }),
    },
  );

  if (!authRes.ok) {
    const err = (await authRes.json().catch(() => ({}))) as { error_description?: string };
    return c.json(
      { error: "auth_failed", message: err.error_description || "Invalid email or password" },
      401,
    );
  }

  // Find the org by email
  const org = (await getOrganizationByEmail(c.env.DB, email)) as { id: string } | null;
  if (!org) {
    return c.json(
      { error: "no_account", message: "No Engram account found for this email. Run 'engram signup' first." },
      404,
    );
  }

  // Check if org already has a key at limit
  const orgRecord = (await getOrganizationById(c.env.DB, org.id)) as { tier?: string } | null;
  const tier = (orgRecord?.tier as Tier) ?? "free";
  const limits = TIER_LIMITS[tier];
  const count = await getApiKeyCount(c.env.DB, org.id);
  if (limits.api_keys !== -1 && (count?.count ?? 0) >= limits.api_keys) {
    return c.json(
      {
        error: "api_key_limit_reached",
        message: "Your account already has an API key. Use your existing key, or manage keys on the dashboard.",
        organization_id: org.id,
      },
      409,
    );
  }

  // Mint a new API key
  const keyId = generateId("key");
  const { raw, prefix } = generateApiKeyRaw();
  const keyHash = await hashApiKey(raw);
  await insertApiKey(c.env.DB, keyId, org.id, keyHash, prefix, "CLI login");

  return c.json({
    organization_id: org.id,
    api_key: raw,
    key_prefix: prefix,
  });
});

export { signup };
