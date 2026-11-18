import type { Env } from "../types.js";
import { websiteBearer } from "../services/secrets.js";

/**
 * Finds organizations whose grace period has expired (grace_ends_at <= now)
 * that are still on a paid tier without a Stripe subscription. Downgrades
 * them to free and calls the website API to send a payment reminder email.
 *
 * Two kinds of org arrive here: one an admin gave the plan to for free, and
 * one that paid once for a fixed time (prepaid_plans, engram#763). The
 * second is told its paid time is over, not that a free gift ended; the
 * website picks the wording from `reason`.
 */
export async function expireGracePeriods(env: Env): Promise<number> {
  const expired = await env.DB.prepare(`
    SELECT id, name, email, tier, grace_ends_at
    FROM organizations
    WHERE grace_ends_at IS NOT NULL
      AND grace_ends_at <= datetime('now')
      AND tier != 'free'
      AND (stripe_subscription_id IS NULL OR stripe_subscription_id = '')
      AND deleted_at IS NULL
  `).all<{
    id: string;
    name: string;
    email: string | null;
    tier: string;
    grace_ends_at: string;
  }>();

  const bearer = websiteBearer(env);
  let count = 0;

  for (const org of expired.results) {
    // Downgrade to free and clear grace
    await env.DB.prepare(
      "UPDATE organizations SET tier = 'free', grace_ends_at = NULL WHERE id = ?"
    ).bind(org.id).run();

    console.log(`[grace] Expired grace for org ${org.id}, downgraded to free`);

    // Did this org pay for the time that just ended? Its latest prepaid
    // plan having run out says so. A failed lookup falls back to the
    // ordinary wording, never to no email.
    let prepaid = false;
    try {
      prepaid = !!(await env.DB.prepare(
        "SELECT 1 FROM prepaid_plans WHERE org_id = ? AND ends_at <= datetime('now') LIMIT 1",
      )
        .bind(org.id)
        .first());
    } catch (err) {
      console.error(`[grace] Could not read prepaid plans for org ${org.id}:`, err);
    }

    // Send payment reminder email via the website API
    if (org.email && env.APP_URL && bearer) {
      try {
        await fetch(`${env.APP_URL}/api/email/payment-reminder`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${bearer}`,
          },
          body: JSON.stringify({
            to: org.email,
            name: org.name,
            tier: org.tier,
            ...(prepaid ? { reason: "prepaid_ended" } : {}),
          }),
        });
      } catch (err) {
        console.error(`[grace] Failed to send the payment reminder for org ${org.id}:`, err);
      }
    }

    count++;
  }

  return count;
}
