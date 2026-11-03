import { clearOrganizationStripeCustomer } from "@getengram/db";
import { customerOwnership, getCustomer } from "./stripe.js";
import type { Env } from "../types.js";

export type ResolvedCustomer =
  | { ok: true; customerId: string; ownership: "own" | "unstamped" }
  | { ok: false; reason: "uncached" | "missing" | "foreign" };

/**
 * The Stripe customer an org may act as, checked against Stripe.
 *
 * `organizations.stripe_customer_id` is a cache, and until engram#443 the
 * lookup that filled it matched customers by email alone, so a row could end
 * up pointing at another org's customer. Every surface that turns the cached
 * id into a Stripe action (the billing portal, checkout, the subscription
 * tool, the reconcile cron and the admin sync) resolves it here first:
 *
 *   - stamped with this org's id         -> use it
 *   - stamped with ANOTHER org's id      -> unlink it, report "foreign"
 *   - gone from Stripe (404 or deleted)  -> unlink it, report "missing"
 *   - no stamp at all                    -> use it, but say so
 *
 * The unlink is compare-and-clear, so a checkout that cached a fresh customer
 * in the meantime is not undone. An unstamped customer is tolerated because
 * absence of proof is not proof that it is someone else's: every code path
 * that creates a customer stamps it, so an unstamped one was attached by
 * hand, and refusing it would orphan a live subscription. For the same
 * reason an operator who moves a customer between orgs must re-stamp it in
 * Stripe, or the move is undone the next time the row is resolved.
 *
 * `unlinkMissing: false` keeps a vanished customer in place and only reports
 * it: the unattended cron uses that, so a revoked or wrong-mode key (every
 * lookup a 404) can never strip the whole fleet of its links.
 *
 * Throws when Stripe cannot be asked. Callers must not guess either way.
 */
export async function resolveCachedCustomer(
  env: Env,
  org: { id: string; stripe_customer_id: string | null },
  opts: { unlinkMissing?: boolean } = {},
): Promise<ResolvedCustomer> {
  const cached = org.stripe_customer_id;
  if (!cached) return { ok: false, reason: "uncached" };

  const customer = await getCustomer(env.STRIPE_SECRET_KEY, cached);
  if (!customer) {
    if (opts.unlinkMissing ?? true) {
      await clearOrganizationStripeCustomer(env.DB, org.id, cached);
      console.log(`[stripe] org ${org.id}: customer ${cached} no longer exists, unlinked`);
    } else {
      console.log(`[stripe] org ${org.id}: customer ${cached} no longer exists`);
    }
    return { ok: false, reason: "missing" };
  }

  const ownership = customerOwnership(customer, org.id);
  if (ownership === "foreign") {
    await clearOrganizationStripeCustomer(env.DB, org.id, cached);
    console.error(
      `[stripe] org ${org.id}: customer ${cached} is stamped for org ${customer.metadata?.organization_id}, unlinked`,
    );
    return { ok: false, reason: "foreign" };
  }
  if (ownership === "unstamped") {
    console.warn(`[stripe] org ${org.id}: customer ${cached} carries no organization_id stamp`);
  }
  return { ok: true, customerId: cached, ownership };
}
