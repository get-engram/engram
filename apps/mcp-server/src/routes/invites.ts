import { Hono } from "hono";
import { generateId, generateApiKeyRaw, hashApiKey } from "@getengram/shared";
import { insertApiKey, acceptSeat, getOrganizationById } from "@getengram/db";
import { verifySupabaseJwt } from "../utils/jwt.js";
import { audit } from "../services/audit.js";
import type { Env } from "../types.js";

type HonoEnv = { Bindings: Env };

const INVITE_TTL_DAYS = 14;

/**
 * Team invite acceptance (engram#263). Public routes keyed by an
 * unguessable invite token (only its hash is stored, like API keys):
 *
 *   GET  /invites/:token  — preview (org name, invited email, state)
 *   POST /invites/accept  — accept; auth = the invitee's Supabase JWT
 *                           (same verification as /signup), body {token}
 *
 * Accepting marks the seat, mints a seat-bound API key on the team org,
 * and returns it so engram-web can point the user's profile at the team.
 */
export const invites = new Hono<HonoEnv>();

interface SeatRow {
  id: string;
  organization_id: string;
  email: string;
  role: string;
  invited_at: string;
  accepted_at: string | null;
}

async function findSeatByToken(db: D1Database, token: string): Promise<SeatRow | null> {
  const hash = await hashApiKey(token);
  return db
    .prepare("SELECT * FROM seats WHERE invite_token_hash = ?")
    .bind(hash)
    .first<SeatRow>();
}

function isExpired(seat: SeatRow): boolean {
  const invited = new Date(seat.invited_at + "Z").getTime();
  return Date.now() - invited > INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;
}

invites.get("/:token", async (c) => {
  const seat = await findSeatByToken(c.env.DB, c.req.param("token"));
  if (!seat) return c.json({ error: "invite_not_found" }, 404);

  const org = (await getOrganizationById(c.env.DB, seat.organization_id)) as
    | { name: string; tier: string }
    | null;

  return c.json({
    org_name: org?.name ?? "an Engram team",
    email: seat.email,
    role: seat.role,
    accepted: !!seat.accepted_at,
    expired: isExpired(seat),
  });
});

invites.post("/accept", async (c) => {
  const jwtSecret = c.env.SUPABASE_JWT_SECRET;
  if (!jwtSecret) {
    return c.json({ error: "server_misconfigured" }, 500);
  }

  const token = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return c.json({ error: "unauthorized" }, 401);

  let claims;
  try {
    claims = await verifySupabaseJwt(token, jwtSecret, c.env.SUPABASE_URL);
  } catch {
    return c.json({ error: "unauthorized" }, 401);
  }
  const email = claims.email;
  if (!email) return c.json({ error: "invalid_token" }, 400);

  const body = await c.req.json<{ token?: string }>().catch(() => ({}) as { token?: string });
  if (!body.token) return c.json({ error: "missing_invite_token" }, 400);

  const seat = await findSeatByToken(c.env.DB, body.token);
  if (!seat) return c.json({ error: "invite_not_found" }, 404);
  if (seat.accepted_at) return c.json({ error: "already_accepted" }, 409);
  if (isExpired(seat)) return c.json({ error: "invite_expired" }, 410);

  const org = (await getOrganizationById(c.env.DB, seat.organization_id)) as
    | { id: string; name: string; tier: string; deleted_at: string | null }
    | null;
  if (!org || org.deleted_at) return c.json({ error: "organization_gone" }, 410);

  // Accept + mint a seat-bound API key on the team org. The token hash is
  // cleared so the invite link is single-use.
  await acceptSeat(c.env.DB, seat.id);
  await c.env.DB.prepare(
    "UPDATE seats SET invite_token_hash = NULL, email = ? WHERE id = ?",
  )
    .bind(email, seat.id)
    .run();

  const { raw, prefix } = generateApiKeyRaw();
  const keyId = generateId("key");
  await insertApiKey(
    c.env.DB,
    keyId,
    seat.organization_id,
    await hashApiKey(raw),
    prefix,
    `Seat — ${email}`,
    "read,write,search,delete",
  );
  await c.env.DB.prepare("UPDATE api_keys SET seat_id = ? WHERE id = ?")
    .bind(seat.id, keyId)
    .run();

  await audit(c.env.DB, seat.organization_id, keyId, "seat.accepted", "seat", seat.id, {
    email,
    invited_email: seat.email,
  });

  return c.json({
    organization_id: seat.organization_id,
    org_name: org.name,
    tier: org.tier,
    api_key: raw,
    seat_id: seat.id,
    role: seat.role,
  });
});
