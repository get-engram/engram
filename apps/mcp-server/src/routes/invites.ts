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

  // The invite is addressed to a PERSON, not to whoever holds the link.
  //
  // This used to accept any signed-in account and then overwrite the seat's
  // email with theirs — so a forwarded invite, a link pasted in Slack, or a
  // leaked URL handed the sender's teammate a full-scope key
  // (read,write,search,delete) on the org's shared memory. The audit entry
  // below has always recorded `email` and `invited_email` as separate
  // fields, which is to say the code knew they could differ and never
  // compared them.
  //
  // Strict match, case- and whitespace-insensitive. There is no legacy data
  // to grandfather: the seats table was empty fleet-wide until the unique
  // index blocking second members was lifted (engram-web#251).
  const invited = (seat.email ?? "").trim().toLowerCase();
  const accepting = email.trim().toLowerCase();
  if (!invited || invited !== accepting) {
    await audit(
      c.env.DB,
      seat.organization_id,
      null,
      "seat.accept_rejected",
      "seat",
      seat.id,
      { invited_email: seat.email ?? null, attempted_by: email },
    );
    return c.json(
      {
        error: "wrong_account",
        message:
          "This invite was sent to a different email address. Sign in with the address it was sent to, or ask for a new invite.",
      },
      403,
    );
  }

  const org = (await getOrganizationById(c.env.DB, seat.organization_id)) as
    | { id: string; name: string; tier: string; deleted_at: string | null }
    | null;
  if (!org || org.deleted_at) return c.json({ error: "organization_gone" }, 410);

  // Accept + mint a seat-bound API key on the team org. The token hash is
  // cleared so the invite link is single-use.
  await acceptSeat(c.env.DB, seat.id);
  // Clearing the hash makes the link single-use. The email is rewritten only
  // to normalise case now that it is known to match the invited address.
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
