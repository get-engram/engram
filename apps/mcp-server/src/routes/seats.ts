import { Hono } from "hono";
import { generateId, hashApiKey } from "@getengram/shared";
import { insertSeat, getSeatsByOrg, getSeatCount, getSeatByEmail, deleteSeat, acceptSeat, getOrganizationById, revokeApiKeysBySeat } from "@getengram/db";
import type { Env, AuthContext } from "../types.js";

type HonoEnv = { Bindings: Env; Variables: { auth: AuthContext } };

const seats = new Hono<HonoEnv>();

// Owner-only guard for seat administration. A seat-bound (Team member) key has
// a non-null seatId; the owner key has null (engram#264). Members must not be
// able to invite, remove, re-invite, or re-role other members — only accept
// their own invite (below) and list. Returns a 403 Response to short-circuit,
// or null to proceed. The `seats.role` column will refine this to owner+admin
// once it's plumbed into AuthContext; owner-only is the safe floor until then.
function ownerOnly(auth: AuthContext): Response | null {
  if (auth.seatId) {
    return Response.json(
      { error: "forbidden", message: "Only the organization owner can manage seats." },
      { status: 403 },
    );
  }
  return null;
}

// List seats
seats.get("/", async (c) => {
  const auth = c.get("auth");
  const result = await getSeatsByOrg(c.env.DB, auth.organizationId);
  return c.json({ seats: result.results });
});

// Invite a seat
seats.post("/", async (c) => {
  const auth = c.get("auth");
  const denied = ownerOnly(auth);
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

// Accept a seat invitation
seats.post("/:id/accept", async (c) => {
  const auth = c.get("auth");
  const seatId = c.req.param("id");

  // Look up the seat and verify it belongs to this org
  const seat = await c.env.DB
    .prepare("SELECT * FROM seats WHERE id = ? AND organization_id = ?")
    .bind(seatId, auth.organizationId)
    .first<{ id: string; email: string; accepted_at: string | null }>();

  if (!seat) {
    return c.json({ error: "seat_not_found" }, 404);
  }
  if (seat.accepted_at) {
    return c.json({ error: "already_accepted" }, 409);
  }

  await acceptSeat(c.env.DB, seatId);
  return c.json({ id: seatId, status: "accepted" });
});

// Update a seat's role (engram-web#92). Owner isn't assignable — it
// belongs to the org account itself, not a seat.
seats.patch("/:id", async (c) => {
  const auth = c.get("auth");
  const denied = ownerOnly(auth);
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
  const denied = ownerOnly(auth);
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
  const denied = ownerOnly(auth);
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
