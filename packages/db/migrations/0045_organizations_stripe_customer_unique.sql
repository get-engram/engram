-- One Stripe customer binds to at most one organization (engram#536, the
-- D1-side backstop for #443/#454). The resolver in
-- services/stripe-customer.ts checks the Stripe-side organization stamp
-- before any cached id is used (that guards the reads), and this index
-- guards the writes: a bind that would make two rows share a customer fails
-- and the caller refuses, so a subscription event can never land on the
-- wrong tenant through the customer-lookup fallback. Partial, because an
-- organization without a customer (the common case) must stay free.
-- 0003's plain idx_orgs_stripe_customer stays for NULL lookups.
CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_stripe_customer_unique
  ON organizations(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;
