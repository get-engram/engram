import { clearOrganizationStripeCustomer, setOrganizationStripeCustomer } from "@getengram/db";
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

export type BindResult = "bound" | "conflict";

/**
 * Point the org row at `customerId`. The partial unique index on
 * organizations(stripe_customer_id) (migration 0045, engram#536) is the
 * D1-side backstop for #443: when another organization already holds this
 * customer the write is refused and nothing changes, and the caller must
 * stop rather than check out against it — a subscription event for a
 * customer two orgs share would land on whichever org the customer lookup
 * returns. Binding an org to the customer it already holds is a no-op
 * success (the webhook re-caches defensively). Any other failure propagates.
 */
export async function bindStripeCustomer(
  db: D1Database,
  orgId: string,
  customerId: string,
): Promise<BindResult> {
  try {
    await setOrganizationStripeCustomer(db, orgId, customerId);
    return "bound";
  } catch (err) {
    if (!isStripeCustomerUniqueViolation(err)) throw err;
    console.error(
      `[stripe] org ${orgId}: customer ${customerId} is already bound to another organization, refusing to cache it`,
    );
    return "conflict";
  }
}

/** D1 surfaces SQLite's constraint failure by message; the column name pins it to our index. */
function isStripeCustomerUniqueViolation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed: organizations\.stripe_customer_id/.test(message);
}
