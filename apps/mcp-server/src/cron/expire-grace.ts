import type { Env } from "../types.js";

/**
 * Finds organizations whose grace period has expired (grace_ends_at <= now)
 * that are still on a paid tier without a Stripe subscription. Downgrades
 * them to free and calls the website API to send a payment reminder email.
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

  let count = 0;

  for (const org of expired.results) {
    // Downgrade to free and clear grace
    await env.DB.prepare(
      "UPDATE organizations SET tier = 'free', grace_ends_at = NULL WHERE id = ?"
    ).bind(org.id).run();

    console.log(`[grace] Expired grace for ${org.email ?? org.id}, downgraded to free`);

    // Send payment reminder email via the website API
    if (org.email && env.APP_URL) {
      try {
        await fetch(`${env.APP_URL}/api/email/payment-reminder`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${(env as Env & { ADMIN_SECRET: string }).ADMIN_SECRET}`,
          },
          body: JSON.stringify({
            to: org.email,
            name: org.name,
            tier: org.tier,
          }),
        });
      } catch (err) {
        console.error(`[grace] Failed to send reminder to ${org.email}:`, err);
      }
    }

    count++;
  }

  return count;
}
