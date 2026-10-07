import { Hono } from "hono";
import {
  generateId,
  generateApiKeyRaw,
  hashApiKey,
  isAcademicEmail,
  emailDomain,
} from "@getengram/shared";
import { audit } from "../services/audit.js";
import type { Env, AuthContext } from "../types.js";

type HonoEnv = { Bindings: Env; Variables: { auth: AuthContext } };

/** How long a verification link stays valid. */
const TOKEN_TTL_MINUTES = 60;
/** How long a verification is good for before re-proving enrollment. */
const VERIFIED_MONTHS = 12;
/** Cap on verification emails per org per day — a cheap anti-spam guard. */
const MAX_SENDS_PER_DAY = 5;

/**
 * Student verification (engram#471).
 *
 *   POST /student/verify   {email}  — send a one-time link to an academic address
 *   POST /student/confirm  {token}  — redeem it; org becomes student-eligible
 *   GET  /student/status            — what the dashboard renders
 *
 * The bar is deliberately "controls an institutional mailbox", not "is
 * currently enrolled". An address check cannot distinguish a student from an
 * alumnus, and we are not pretending otherwise — the owner's call is that
 * reach matters more than leakage at this price point. Enrollment is
 * re-asserted annually via student_expires_at, which is the one lever that
 * stops a discount lasting forever.
 */
export const student = new Hono<HonoEnv>();

student.post("/verify", async (c) => {
  const auth = c.get("auth");
  const body = await c.req
    .json<{ email?: string }>()
    .catch(() => ({}) as { email?: string });
  const email = (body.email ?? "").trim().toLowerCase();

  if (!email || !emailDomain(email)) {
    return c.json(
      { error: "invalid_email", message: "A valid email address is required." },
      400,
    );
  }

  if (!isAcademicEmail(email)) {
    return c.json(
      {
        error: "not_academic",
        message:
          "That doesn't look like a university address. Student pricing needs an " +
          "address issued by your institution (for example yourname@university.edu). " +
          "If your university uses a domain we don't recognise, email hello@getengram.app " +
          "and we'll sort it out by hand.",
        domain: emailDomain(email),
      },
      422,
    );
  }

  // Rate limit per org per day. The token itself is unguessable, so this
  // guards against using us to send mail at someone, not against brute force.
  const recent = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM student_verifications
     WHERE organization_id = ? AND created_at > datetime('now', '-1 day')`,
  )
    .bind(auth.organizationId)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= MAX_SENDS_PER_DAY) {
    return c.json(
      {
        error: "rate_limited",
        message: "Too many verification emails today. Try again tomorrow.",
      },
      429,
    );
  }

  // Reuses the API-key generator purely for its CSPRNG output shape; only
  // the hash is persisted, and the raw value is emailed once and forgotten.
  const { raw: token } = generateApiKeyRaw();
  const tokenHash = await hashApiKey(token);

  await c.env.DB.prepare(
    `INSERT INTO student_verifications (id, organization_id, email, token_hash)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(generateId("stv"), auth.organizationId, email, tokenHash)
    .run();

  // Mail goes out via engram-web, which owns the Resend credentials and the
  // templates — same path every cron nudge uses.
  const secret = (c.env as Env & { ADMIN_SECRET?: string }).ADMIN_SECRET;
  const verifyUrl = `${c.env.APP_URL}/student/confirm?token=${encodeURIComponent(token)}`;
  let delivered = false;
  if (secret && c.env.APP_URL) {
    try {
      const res = await fetch(`${c.env.APP_URL}/api/email/student-verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({
          to: email,
          verify_url: verifyUrl,
          expires_minutes: TOKEN_TTL_MINUTES,
        }),
      });
      delivered = res.ok;
      if (!res.ok) {
        console.error(`[student] verify email failed: ${res.status}`);
      }
    } catch (err) {
      console.error(
        `[student] verify email threw: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  await audit(
    c.env.DB,
    auth.organizationId,
    auth.apiKeyId,
    "student.verify_sent",
    "organization",
    auth.organizationId,
    { domain: emailDomain(email), delivered },
  );

  // The response never reveals whether delivery succeeded in a way that
  // confirms the address exists; it just says what we did.
  return c.json({
    sent: true,
    email,
    expires_minutes: TOKEN_TTL_MINUTES,
  });
});

student.post("/confirm", async (c) => {
  const body = await c.req
    .json<{ token?: string }>()
    .catch(() => ({}) as { token?: string });
  const token = (body.token ?? "").trim();
  if (!token) {
    return c.json({ error: "invalid_request", message: "token is required" }, 400);
  }

  const hash = await hashApiKey(token);
  const row = await c.env.DB.prepare(
    `SELECT id, organization_id, email, created_at, consumed_at
     FROM student_verifications WHERE token_hash = ?`,
  )
    .bind(hash)
    .first<{
      id: string;
      organization_id: string;
      email: string;
      created_at: string;
      consumed_at: string | null;
    }>();

  // Unknown, already used, and expired are all reported the same way — a
  // probing caller learns nothing about which tokens ever existed.
  const expired =
    !!row &&
    Date.now() - new Date(row.created_at + "Z").getTime() >
      TOKEN_TTL_MINUTES * 60 * 1000;
  if (!row || row.consumed_at || expired) {
    return c.json(
      {
        error: "invalid_token",
        message: "That verification link is invalid or has expired. Request a new one.",
      },
      400,
    );
  }

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE student_verifications SET consumed_at = datetime('now') WHERE id = ?`,
    ).bind(row.id),
    c.env.DB.prepare(
      `UPDATE organizations
         SET student_email = ?,
             student_verified_at = datetime('now'),
             student_expires_at = datetime('now', ?)
       WHERE id = ?`,
    ).bind(row.email, `+${VERIFIED_MONTHS} months`, row.organization_id),
  ]);

  await audit(
    c.env.DB,
    row.organization_id,
    "student-verify",
    "student.verified",
    "organization",
    row.organization_id,
    { domain: emailDomain(row.email) },
  );

  return c.json({
    verified: true,
    email: row.email,
    expires_in_months: VERIFIED_MONTHS,
  });
});

student.get("/status", async (c) => {
  const auth = c.get("auth");
  const org = await c.env.DB.prepare(
    `SELECT tier, student_email, student_verified_at, student_expires_at
     FROM organizations WHERE id = ?`,
  )
    .bind(auth.organizationId)
    .first<{
      tier: string;
      student_email: string | null;
      student_verified_at: string | null;
      student_expires_at: string | null;
    }>();

  const active =
    !!org?.student_verified_at &&
    !!org.student_expires_at &&
    new Date(org.student_expires_at + "Z").getTime() > Date.now();

  return c.json({
    eligible: active,
    tier: org?.tier ?? "free",
    email: org?.student_email ?? null,
    verified_at: org?.student_verified_at ?? null,
    expires_at: org?.student_expires_at ?? null,
  });
});
