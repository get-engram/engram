import { Hono } from "hono";
import { getPrivacySettings, updatePrivacySettings } from "@getengram/db";
import { audit } from "../services/audit.js";
import type { Env, AuthContext } from "../types.js";

type HonoEnv = { Bindings: Env; Variables: { auth: AuthContext } };

const privacy = new Hono<HonoEnv>();

// GET /api/privacy — current privacy & sharing settings for the org.
privacy.get("/", async (c) => {
  const auth = c.get("auth");
  const row = await getPrivacySettings(c.env.DB, auth.organizationId);
  return c.json({
    // Default open when the columns are missing (pre-migration rows).
    assistant_can_read_bodies: row?.assistant_can_read_bodies !== 0,
    assistant_can_read_cross_conversation:
      row?.assistant_can_read_cross_conversation !== 0,
  });
});

// PATCH /api/privacy — update either/both toggles. Omitted fields are left as-is.
privacy.patch("/", async (c) => {
  const auth = c.get("auth");
  const orgId = auth.organizationId;
  const body = await c.req
    .json<{
      assistant_can_read_bodies?: unknown;
      assistant_can_read_cross_conversation?: unknown;
    }>()
    .catch(() => ({}));

  const bodies = (body as Record<string, unknown>).assistant_can_read_bodies;
  const cross = (body as Record<string, unknown>)
    .assistant_can_read_cross_conversation;

  if (
    (bodies !== undefined && typeof bodies !== "boolean") ||
    (cross !== undefined && typeof cross !== "boolean")
  ) {
    return c.json(
      {
        error: "invalid_settings",
        message:
          "assistant_can_read_bodies and assistant_can_read_cross_conversation must be booleans",
      },
      400,
    );
  }

  // Merge onto current values so a partial PATCH doesn't reset the other toggle.
  const current = await getPrivacySettings(c.env.DB, orgId);
  const next = {
    assistant_can_read_bodies:
      typeof bodies === "boolean"
        ? bodies
        : current?.assistant_can_read_bodies !== 0,
    assistant_can_read_cross_conversation:
      typeof cross === "boolean"
        ? cross
        : current?.assistant_can_read_cross_conversation !== 0,
  };

  await updatePrivacySettings(c.env.DB, orgId, next);
  await audit(c.env.DB, orgId, auth.apiKeyId, "privacy.update", undefined, undefined, next);

  return c.json({ updated: true, ...next });
});

export { privacy };
