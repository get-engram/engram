import { Hono } from "hono";
import { generateId, hashApiKey } from "@getengram/shared";
import { insertSeat, getSeatsByOrg, getSeatCount, getSeatByEmail, deleteSeat, getOrganizationById, revokeApiKeysBySeat } from "@getengram/db";
import {
  denyExternalOAuthClient,
  denyUnlessFirstPartyWrite,
  denyUnlessFullAuthority,
  denyUnlessOwner,
  type GuardContext,
} from "./guards.js";
import type { Env, AuthContext } from "../types.js";

type HonoEnv = { Bindings: Env; Variables: { auth: AuthContext } };

const seats = new Hono<HonoEnv>();

const MEMBER_REFUSAL = "Only the organization owner can manage seats.";
const CONNECTOR_REFUSAL =
  "Team members are managed from the Engram dashboard, not from a connected app.";

// Who belongs to the org is account administration, not memory: a connected
// OAuth app never reads or changes it (engram#603).
seats.use("*", async (c, next) => {
  const denied = denyExternalOAuthClient(c, CONNECTOR_REFUSAL);
  if (denied) return denied;
  await next();
});

// Owner-only floor for seat administration. A seat-bound (Team member) key
// has a non-null seatId; the owner key has null (engram#264). Members can list
// but not invite, remove, re-invite, or re-role. The `seats.role` column will
// refine this to owner+admin once it's plumbed into AuthContext; owner-only is
// the safe floor until then.
//
// Changing or removing a member also needs `write` (engram#603).
function denySeatChange(c: GuardContext): Response | null {
  return denyUnlessOwner(c, MEMBER_REFUSAL) ?? denyUnlessFirstPartyWrite(c, CONNECTOR_REFUSAL);
}

// Issuing an invitation issues a credential: once accepted it mints a seat
// key with every scope (invites.ts). So the caller must hold every scope
// itself, as mintableScopes requires of POST /api/keys (engram#475, #603).
function denyInvite(c: GuardContext): Response | null {
  return denyUnlessFullAuthority(c, { connector: CONNECTOR_REFUSAL, member: MEMBER_REFUSAL });
}

interface SeatRow {
  id: string;
  email: string;
  role: string;
  invited_at: string;
  accepted_at: string | null;
}

// List seats: the fields the dashboard shows, nothing else. The row also
// holds the hash of a pending invite's token, which no caller needs
// (engram#603).
seats.get("/", async (c) => {
  const auth = c.get("auth");
  const result = await getSeatsByOrg(c.env.DB, auth.organizationId);
  const rows = (result.results ?? []) as unknown as SeatRow[];
  return c.json({
    seats: rows.map(({ id, email, role, invited_at, accepted_at }) => ({
      id,
      email,
      role,
      invited_at,
      accepted_at,
    })),
  });
});

// Invite a seat
seats.post("/", async (c) => {
  const auth = c.get("auth");
  const denied = denyInvite(c);
  if (denied) return denied;
  const body = await c.req.json<{ email: string; role?: string }>().catch(() => ({}) as { email?: string; role?: string });

  if (!body.email) {
    return c.json({ error: "Email is required" }, 400);
  }

  // Check seat limit from org (set by Stripe subscription quantity)
  const org = await getOrganizationById(c.env.DB, auth.organizationId) as
    | { seat_limit: number } | null;
  const seatLimit = org?.seat_limit ?? 1;
  const count = await getSeatCount(c.env.DB, auth.organizationId);
  if ((count?.count ?? 0) >= seatLimit) {
    return c.json({
      error: "seat_limit_exceeded",
      message: `Your plan allows ${seatLimit} seat(s). Add more seats at https://getengram.app/pricing`,
      limit: seatLimit,
    }, 403);
  }

  const id = generateId("seat");
  const role = body.role || "member";

  try {
    await insertSeat(c.env.DB, id, auth.organizationId, body.email, role);
  } catch (e) {
    const error = e as Error;
    if (error.message?.includes("UNIQUE")) {
      return c.json({ error: "This email is already a member of this organization" }, 409);
    }
    throw e;
  }

  // Single-use invite token (engram#263) — returned raw exactly once so
  // the caller (engram-web) can email an accept link; only the hash is
  // stored. Accepting happens on the public /invites routes.
  const tokenBytes = new Uint8Array(24);
  crypto.getRandomValues(tokenBytes);
  const inviteToken =
    "inv_" + Array.from(tokenBytes, (b) => b.toString(16).padStart(2, "0")).join("");
  await c.env.DB.prepare("UPDATE seats SET invite_token_hash = ? WHERE id = ?")
    .bind(await hashApiKey(inviteToken), id)
    .run();

  return c.json(
    { id, email: body.email, role, status: "invited", invite_token: inviteToken },
    201,
  );
});

// There is no accept route here. An invitation is accepted on the public
// POST /invites/accept, by the invitee proving the invited address
// (engram#263). The older POST /:id/accept let any credential in the org mark
// a pending seat accepted without the invitee, which then blocked the real
// acceptance as "already accepted"; nothing called it, so it is gone
// (engram#603).

// Update a seat's role (engram-web#92). Owner isn't assignable — it
// belongs to the org account itself, not a seat.
seats.patch("/:id", async (c) => {
  const auth = c.get("auth");
  const denied = denySeatChange(c);
  if (denied) return denied;
  const seatId = c.req.param("id");
  const body = await c.req.json<{ role?: string }>().catch(() => ({}) as { role?: string });
  if (body.role !== "admin" && body.role !== "member") {
    return c.json({ error: "invalid_role", allowed: ["admin", "member"] }, 400);
  }
  const result = await c.env.DB.prepare(
    "UPDATE seats SET role = ? WHERE id = ? AND organization_id = ?",
  )
    .bind(body.role, seatId, auth.organizationId)
    .run();
  if (result.meta?.changes === 0) return c.json({ error: "seat_not_found" }, 404);
  return c.json({ id: seatId, role: body.role });
});

// Re-send an invite (engram#263): mint a fresh single-use token for a
// still-pending seat. The caller (engram-web) emails the new link.
seats.post("/:id/resend", async (c) => {
  const auth = c.get("auth");
  const denied = denyInvite(c);
  if (denied) return denied;
  const seatId = c.req.param("id");
  const seat = await c.env.DB.prepare(
    "SELECT id, email, accepted_at FROM seats WHERE id = ? AND organization_id = ?",
  )
    .bind(seatId, auth.organizationId)
    .first<{ id: string; email: string; accepted_at: string | null }>();
  if (!seat) return c.json({ error: "seat_not_found" }, 404);
  if (seat.accepted_at) return c.json({ error: "already_accepted" }, 409);

  const tokenBytes = new Uint8Array(24);
  crypto.getRandomValues(tokenBytes);
  const inviteToken =
    "inv_" + Array.from(tokenBytes, (b) => b.toString(16).padStart(2, "0")).join("");
  await c.env.DB.prepare(
    "UPDATE seats SET invite_token_hash = ?, invited_at = datetime('now') WHERE id = ?",
  )
    .bind(await hashApiKey(inviteToken), seatId)
    .run();

  return c.json({ id: seatId, email: seat.email, invite_token: inviteToken });
});

// Remove a seat (and revoke its API keys)
seats.delete("/:id", async (c) => {
  const auth = c.get("auth");
  const denied = denySeatChange(c);
  if (denied) return denied;
  const seatId = c.req.param("id");
  // Verify the seat belongs to the caller's org BEFORE deleting. Seat ids are
  // globally unique, so deleteSeat/revokeApiKeysBySeat by bare id would let an
  // owner remove another tenant's seat and revoke its keys — a cross-tenant
  // write. Scope the lookup to this org and 404 otherwise.
  const seat = await c.env.DB
    .prepare("SELECT id FROM seats WHERE id = ? AND organization_id = ?")
    .bind(seatId, auth.organizationId)
    .first<{ id: string }>();
  if (!seat) return c.json({ error: "seat_not_found" }, 404);
  await revokeApiKeysBySeat(c.env.DB, seatId);
  await deleteSeat(c.env.DB, seatId);
  return c.json({ removed: true });
});

export { seats };
