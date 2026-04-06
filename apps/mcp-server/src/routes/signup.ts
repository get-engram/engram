import { Hono } from "hono";
import {
  SignupSchema,
  generateId,
  generateApiKeyRaw,
  hashApiKey,
} from "@engram/shared";
import {
  getOrganizationByEmail,
  insertOrganizationWithEmail,
  insertApiKey,
} from "@engram/db";
import type { Env } from "../types.js";

type HonoEnv = { Bindings: Env };

const signup = new Hono<HonoEnv>();

signup.post("/signup", async (c) => {
  const body = await c.req.json();
  const parsed = SignupSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      400,
    );
  }

  const { email, plan } = parsed.data;

  // Check if org with this email already exists
  const existing = await getOrganizationByEmail(c.env.DB, email);
  if (existing) {
    return c.json(
      { error: "An account with this email already exists" },
      409,
    );
  }

  // Create org
  const orgId = generateId("org");
  const orgName = email.split("@")[0];
  await insertOrganizationWithEmail(c.env.DB, orgId, orgName, email);

  // Create API key
  const keyId = generateId("key");
  const { raw, prefix } = generateApiKeyRaw();
  const keyHash = await hashApiKey(raw);
  await insertApiKey(c.env.DB, keyId, orgId, keyHash, prefix, "Default");

  return c.json({
    organization_id: orgId,
    api_key: raw,
    key_prefix: prefix,
    plan,
  });
});

export { signup };
