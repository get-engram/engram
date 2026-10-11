import { generateId, hashApiKey } from "@getengram/shared";
import { audit } from "./audit.js";
import type { Env } from "../types.js";

/**
 * Account claim — proving an inbox before a sign-in may own an org
 * (engram#475 audit; #476 added the gate, migration 0040 added the way through).
 *
 * Supabase auto-confirms addresses, so a JWT's email proves a string was
 * typed, not that an inbox was read. Every surface that binds a Supabase user
 * to an org (web /signup, CLI login, ChatGPT/Claude connect) therefore asks
 * two questions, in order:
 *
 *   1. Is this sub already on org_identities for the org? Then it is the
 *      org's own user coming back through a new surface — connect, no gate.
 *   2. Otherwise, does the org hold memories? Then the sub must prove the
 *      inbox: we mail a one-time link to the org's address and POST
 *      /signup/claim redeems it. An empty org has nothing to take over and
 *      binds freely.
 *
 * Only the token HASH is stored. One row per send is the trail; the daily cap
 * counts rows; a row whose email never left is deleted so the cooldown and
 * the cap stay truthful. A (org, sub, 2-minute window) unique index turns a
 * parallel burst — the dashboard rendering twice — into one email, not N.
 */
export function requiresClaim(org: { messages_stored_total?: number | null }): boolean {
  return (org.messages_stored_total ?? 0) > 0;
}

export const CLAIM_TTL_MINUTES = 30;
/** A fresh link is not re-sent inside this window — a reload is not a request for another email. */
export const CLAIM_RESEND_COOLDOWN_SECONDS = 120;
/** Per org per day. The token is unguessable; this stops us being used to mail someone. */
export const CLAIM_MAX_SENDS_PER_DAY = 5;

export type ClaimReason = "sent" | "cooldown" | "rate_limited" | "delivery_failed";
export type ClaimSurface = "web" | "cli" | "oauth";
export interface ClaimState {
  email: string;
  sent: boolean;
  reason: ClaimReason;
  expires_minutes: number;
  retry_after_seconds: number;
}

/** 32 bytes of CSPRNG as base64url — only ever stored hashed. */
function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function startClaim(
  env: Env,
  org: { id: string; messages_stored_total?: number | null },
  sub: string,
  email: string,
  via: ClaimSurface,
): Promise<ClaimState> {
  const base = { email, expires_minutes: CLAIM_TTL_MINUTES };
  const cooldown = (retryAfter: number): ClaimState => ({
    ...base,
    sent: false,
    reason: "cooldown",
    retry_after_seconds: Math.max(1, Math.ceil(retryAfter)),
  });

  // An unconsumed link for this (org, sub) issued moments ago means the
  // dashboard reloaded, not that the user needs another email.
  const recent = await env.DB.prepare(
    `SELECT created_at FROM org_claims
     WHERE organization_id = ? AND sub = ? AND consumed_at IS NULL
       AND created_at > datetime('now', ?)
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(org.id, sub, `-${CLAIM_RESEND_COOLDOWN_SECONDS} seconds`)
    .first<{ created_at: string }>();
  if (recent) {
    const ageSec = (Date.now() - new Date(recent.created_at + "Z").getTime()) / 1000;
    return cooldown(CLAIM_RESEND_COOLDOWN_SECONDS - ageSec);
  }

  const today = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM org_claims
     WHERE organization_id = ? AND created_at > datetime('now', '-1 day')`,
  )
    .bind(org.id)
    .first<{ n: number }>();
  if ((today?.n ?? 0) >= CLAIM_MAX_SENDS_PER_DAY) {
    return { ...base, sent: false, reason: "rate_limited", retry_after_seconds: 24 * 3600 };
  }

  // The window is computed in SQL so every isolate shares one clock. Two
  // requests landing in the same 2-minute bucket collide on the unique index;
  // the loser sees changes=0 and reports cooldown instead of sending a twin.
  const id = generateId("clm");
  const token = randomToken();
  const tokenHash = await hashApiKey(token);
  const ins = await env.DB.prepare(
    `INSERT OR IGNORE INTO org_claims (id, organization_id, sub, email, token_hash, expires_at, send_window)
     VALUES (?, ?, ?, ?, ?, datetime('now', ?),
             strftime('%Y-%m-%d %H:', 'now') || printf('%02d', (CAST(strftime('%M', 'now') AS INTEGER) / 2) * 2))`,
  )
    .bind(id, org.id, sub, email, tokenHash, `+${CLAIM_TTL_MINUTES} minutes`)
    .run();
  if ((ins.meta?.changes ?? 0) === 0) return cooldown(CLAIM_RESEND_COOLDOWN_SECONDS);

  // Mail goes out via engram-web, which owns the Resend credentials and the
  // templates — the same path student verification and every nudge use.
  const secret = (env as Env & { ADMIN_SECRET?: string }).ADMIN_SECRET;
  const claimUrl = `${env.APP_URL}/claim?token=${encodeURIComponent(token)}`;
  let delivered = false;
  if (secret && env.APP_URL) {
    try {
      const res = await fetch(`${env.APP_URL}/api/email/claim-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        body: JSON.stringify({
          to: email,
          claim_url: claimUrl,
          expires_minutes: CLAIM_TTL_MINUTES,
          messages: org.messages_stored_total ?? undefined,
        }),
      });
      delivered = res.ok;
      if (!res.ok) console.error(`[claim] link email failed: ${res.status}`);
    } catch (err) {
      console.error(`[claim] link email threw: ${err instanceof Error ? err.message : err}`);
    }
  }
  // A token that never reached an inbox cannot be redeemed; leaving the row
  // would report "cooldown" on the retry and burn the daily cap on nothing.
  if (!delivered) {
    await env.DB.prepare(`DELETE FROM org_claims WHERE id = ?`).bind(id).run();
  }

  // One audit row per attempted send — not per gate hit, which an attacker
  // holding a JWT could otherwise loop into the log for free.
  await audit(env.DB, org.id, null, "signup.claim_required", "organization", org.id, {
    sub,
    via,
    delivered,
  });

  return {
    ...base,
    sent: delivered,
    reason: delivered ? "sent" : "delivery_failed",
    retry_after_seconds: CLAIM_RESEND_COOLDOWN_SECONDS,
  };
}

/** User-facing sentence for a claim_required response, per surface and outcome. */
export function claimMessage(claim: ClaimState, via: ClaimSurface): string {
  const lead = `An Engram account with saved memories already exists for ${claim.email}.`;
  const again =
    via === "cli" ? " Then run 'engram login' again." : via === "oauth" ? " Then connect again." : "";
  const support = ` Email hello@getengram.app from ${claim.email} and we'll connect it by hand.`;
  switch (claim.reason) {
    case "sent":
      return `${lead} To connect this sign-in to it, open the link we just emailed to ${claim.email} (valid ${claim.expires_minutes} minutes).${again} Nothing in the account is affected.`;
    case "cooldown":
      return `${lead} We emailed a link to ${claim.email} a moment ago — check your inbox and spam folder.${again} You can request another in about ${Math.ceil(claim.retry_after_seconds / 60)} minute(s).`;
    case "rate_limited":
      return `${lead} Too many connection links were requested today.${support}`;
    case "delivery_failed":
      return `${lead} We couldn't send the connection link.${support}`;
  }
}
