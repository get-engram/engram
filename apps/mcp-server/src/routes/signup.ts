import { Hono } from "hono";
import {
  SignupSchema,
  generateId,
  generateApiKeyRaw,
  hashApiKey,
} from "@getengram/shared";
import {
  getOrganizationByEmail,
  insertOrganizationWithEmail,
  insertApiKey,
} from "@getengram/db";
import type { Env } from "../types.js";

type HonoEnv = { Bindings: Env };

const signup = new Hono<HonoEnv>();

// POST /signup — mint (or attach) an API key for a given email.
//
// Auth: shared-secret Bearer. The Next.js server action on engram-web
// sends `Authorization: Bearer ${WORKER_SIGNUP_SECRET}` so random
// internet traffic can't mint keys against arbitrary emails. This is
// a temporary mitigation until stage 2, when the worker will verify
// Supabase JWTs via JWKS and take the user identity from there.
//
// Behavior is idempotent-ish: if an org already exists for this email
// (either from the pre-Supabase self-serve flow, or from a race on
// the same user's first sign-in), we attach a fresh API key to the
// existing org and return it. We never return the user's previous
// key — it's hashed.
signup.post("/", async (c) => {
  // Shared-secret gate
  const configured = c.env.WORKER_SIGNUP_SECRET;
  if (!configured) {
    return c.json(
      { error: "server_misconfigured", message: "WORKER_SIGNUP_SECRET is not set" },
      500,
    );
  }
  const authHeader = c.req.header("authorization") ?? "";
  const presented = authHeader.replace(/^Bearer\s+/i, "");
  if (presented !== configured) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = SignupSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: "invalid_input", details: parsed.error.flatten() },
      400,
    );
  }

  const { email, plan } = parsed.data;

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
  // key (it's hashed at rest), so stage-1 callers rely on this being
  // the canonical way to bootstrap server-side credentials for a user.
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

export { signup };
