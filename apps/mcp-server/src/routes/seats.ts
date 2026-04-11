import { Hono } from "hono";
import { generateId, TIER_LIMITS } from "@getengram/shared";
import { insertSeat, getSeatsByOrg, getSeatCount, deleteSeat } from "@getengram/db";
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

  // Check seat limit
  const limits = TIER_LIMITS[auth.tier];
  if (limits.seats !== -1) {
    const count = await getSeatCount(c.env.DB, auth.organizationId);
    if ((count?.count ?? 0) >= limits.seats) {
      return c.json({
        error: "seat_limit_exceeded",
        message: `Your ${auth.tier} plan allows ${limits.seats} seat(s). Upgrade at https://getengram.app/pricing`,
        limit: limits.seats,
      }, 403);
    }
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

  return c.json({ id, email: body.email, role, status: "invited" }, 201);
});

// Remove a seat
seats.delete("/:id", async (c) => {
  const auth = c.get("auth");
  const seatId = c.req.param("id");
  await deleteSeat(c.env.DB, seatId);
  return c.json({ removed: true });
});

export { seats };
