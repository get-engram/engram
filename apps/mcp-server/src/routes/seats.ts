import { Hono } from "hono";
import { generateId, hashApiKey } from "@getengram/shared";
import { insertSeat, getSeatsByOrg, getSeatCount, getSeatByEmail, deleteSeat, acceptSeat, getOrganizationById, revokeApiKeysBySeat } from "@getengram/db";
import type { Env, AuthContext } from "../types.js";

type HonoEnv = { Bindings: Env; Variables: { auth: AuthContext } };

const seats = new Hono<HonoEnv>();

// List seats
seats.get("/", async (c) => {
  const auth = c.get("auth");
  const result = await getSeatsByOrg(c.env.DB, auth.organizationId);
  return c.json({ seats: result.results });
});

// Invite a seat
seats.post("/", async (c) => {
  const auth = c.get("auth");
  const body = await c.req.json<{ email: string; role?: string }>();

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

// Remove a seat (and revoke its API keys)
seats.delete("/:id", async (c) => {
  const auth = c.get("auth");
  const seatId = c.req.param("id");
  await revokeApiKeysBySeat(c.env.DB, seatId);
  await deleteSeat(c.env.DB, seatId);
  return c.json({ removed: true });
});

export { seats };
