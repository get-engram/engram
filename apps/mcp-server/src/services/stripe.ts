// Minimal Stripe client for Cloudflare Workers — uses fetch against the
// Stripe REST API directly and Web Crypto for webhook signature
// verification, so we don't need to ship the `stripe` npm package (which
// pulls in Node-only Buffer / crypto code).

const STRIPE_API = "https://api.stripe.com/v1";

function encodeForm(obj: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    params.append(k, String(v));
  }
  return params.toString();
}

async function stripeFetch<T = unknown>(
  secretKey: string,
  path: string,
  body?: Record<string, string | number | undefined>,
): Promise<T> {
  const init: RequestInit = {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };
  if (body) init.body = encodeForm(body);

  const res = await fetch(`${STRIPE_API}${path}`, init);
  const json = (await res.json()) as T & { error?: { message: string } };
  if (!res.ok) {
    const msg = json?.error?.message || `Stripe API ${res.status}`;
    throw new Error(`stripe: ${msg}`);
  }
  return json;
}

/**
 * Product + price provisioning (one-time setup, driven by /admin).
 *
 * Prices are normally created by hand in the Stripe dashboard, but the Stripe
 * CLI's restricted key has no `product_write` permission, so the student price
 * could not be created from a terminal. The worker's own STRIPE_SECRET_KEY
 * can do it, and doing it here means the price is created with the exact
 * lookup_key and metadata the webhook's tier mapping expects rather than
 * whatever a hand-typed form produced.
 *
 * Idempotent by lookup_key: a second call returns the existing price and
 * creates nothing. Never updates an existing price — Stripe prices are
 * immutable by design, and silently repointing a plan's price is how live
 * subscribers end up billed a different amount.
 */
export interface StripePrice {
  id: string;
  unit_amount: number | null;
  currency: string;
  lookup_key: string | null;
  active: boolean;
  livemode: boolean;
  product: string;
  recurring: { interval: string } | null;
}

export async function findPriceByLookupKey(
  secretKey: string,
  lookupKey: string,
): Promise<StripePrice | null> {
  const res = await stripeFetch<{ data: StripePrice[] }>(
    secretKey,
    `/prices?lookup_keys[]=${encodeURIComponent(lookupKey)}&active=true&limit=1`,
  );
  return res.data?.[0] ?? null;
}

/**
 * Reconcile a product's name and description with what the code says they
 * should be.
 *
 * The "ensure price" endpoints short-circuit as soon as a price exists at the
 * right amount, which is correct for the PRICE — Stripe prices are immutable
 * and recreating one churns the lookup key. But it meant the PRODUCT text
 * never got reconciled, so a description edited in code silently never
 * reached checkout. That is how the Education Team product ended up telling
 * customers it needs a "verified academic email" while every other surface,
 * including the Student product beside it, said "university email".
 *
 * Products are mutable, so this is a plain update. Returns true if anything
 * actually changed, so callers can report it honestly.
 */
export async function reconcileProduct(
  secretKey: string,
  productId: string,
  want: { name: string; description: string },
): Promise<boolean> {
  const current = await stripeFetch<{ name?: string; description?: string }>(
    secretKey,
    `/products/${encodeURIComponent(productId)}`,
  );
  if (current.name === want.name && current.description === want.description) {
    return false;
  }
  await stripeFetch(secretKey, `/products/${encodeURIComponent(productId)}`, {
    name: want.name,
    description: want.description,
  });
  return true;
}

export async function createRecurringPrice(
  secretKey: string,
  params: {
    productName: string;
    productDescription: string;
    tier: string;
    unitAmount: number;
    lookupKey: string;
    nickname: string;
    currency?: string;
    /**
     * Move the lookup key off whatever price currently holds it. Stripe
     * prices are immutable, so a price CHANGE is always a new price — and
     * without this the key stays pinned to the old one, leaving two prices
     * where `team_monthly` means the superseded amount.
     */
    transferLookupKey?: boolean;
  },
): Promise<StripePrice> {
  const product = await stripeFetch<{ id: string }>(secretKey, `/products`, {
    name: params.productName,
    description: params.productDescription,
    "metadata[tier]": params.tier,
  });
  return stripeFetch<StripePrice>(secretKey, `/prices`, {
    product: product.id,
    unit_amount: params.unitAmount,
    currency: params.currency ?? "usd",
    "recurring[interval]": "month",
    lookup_key: params.lookupKey,
    ...(params.transferLookupKey ? { transfer_lookup_key: "true" } : {}),
    nickname: params.nickname,
    "metadata[tier]": params.tier,
  });
}

/**
 * The ONE price -> tier mapping.
 *
 * There used to be two. billing.ts (webhook) knew about the student price;
 * stripe-sync.ts (the 10-minute reconcile cron) did not — it read
 * `let tier = "pro"; if (priceId === STRIPE_PRICE_ID_TEAM) tier = "team";`
 * so every price that was not Team fell through to "pro". The result: a real
 * $3/month student subscriber (mwill002@odu.edu, verified 2026-10-12) was
 * rewritten from "student" to "pro" within ten minutes of every correction,
 * which is why the admin dashboard never showed a student. Entitlements are
 * identical so nothing broke for the user, but the operator could not see
 * who was on the plan and the paid-plan counts misattributed them.
 *
 * Returns null for a price the deployment does not recognise — callers must
 * decide what that means rather than guessing a tier.
 */
export function priceToTier(
  env: {
    STRIPE_PRICE_ID_PRO?: string;
    STRIPE_PRICE_ID_TEAM?: string;
    STRIPE_PRICE_ID_STUDENT?: string;
    STRIPE_PRICE_ID_EDU_TEAM?: string;
  },
  priceId: string | undefined,
): "pro" | "student" | "team" | null {
  if (!priceId) return null;
  if (priceId === env.STRIPE_PRICE_ID_PRO) return "pro";
  if (priceId === env.STRIPE_PRICE_ID_TEAM) return "team";
  if (priceId === env.STRIPE_PRICE_ID_STUDENT) return "student";
  // Education Team is the TEAM tier at an academic price — deliberately not a
  // separate tier. Entitlements are identical, and `tier === "team"` guards
  // pooled per-seat storage (services/tier.ts) and the seat limit; a parallel
  // tier would have to be added to every one of those call sites, and missing
  // one silently gives a department a single seat's worth of memory.
  if (priceId === env.STRIPE_PRICE_ID_EDU_TEAM) return "team";
  return null;
}

/** Team is a shared plan: one seat is Pro with extra steps. */
export const TEAM_MIN_SEATS = 2;

/**
 * Which Stripe price a plan resolves to, and the seat floor that goes with it.
 *
 * Lives here because there are TWO checkout paths — POST /api/billing/checkout
 * and the manage_subscription MCP tool — and they had already drifted: the MCP
 * tool quoted "$39/mo" and "$49/mo" at the point of purchase (real prices: $9)
 * and applied no seat minimum at all, so an agent could buy the single-seat
 * team that the web path now refuses. One resolver, both callers.
 *
 * Education pricing is not a separate plan the caller asks for — it is the
 * Team plan bought by an org that has verified a university address. Asking
 * for the discount cannot grant it; only the verification does.
 */
export function resolvePlanPrice(
  env: {
    STRIPE_PRICE_ID_PRO?: string;
    STRIPE_PRICE_ID_TEAM?: string;
    STRIPE_PRICE_ID_STUDENT?: string;
    STRIPE_PRICE_ID_EDU_TEAM?: string;
  },
  plan: "pro" | "team" | "student",
  opts: { academicallyVerified?: boolean } = {},
): { priceId: string | undefined; minSeats: number; academic: boolean } {
  if (plan === "team") {
    const academic = Boolean(opts.academicallyVerified && env.STRIPE_PRICE_ID_EDU_TEAM);
    return {
      priceId: academic ? env.STRIPE_PRICE_ID_EDU_TEAM : env.STRIPE_PRICE_ID_TEAM,
      minSeats: TEAM_MIN_SEATS,
      academic,
    };
  }
  if (plan === "student") {
    return { priceId: env.STRIPE_PRICE_ID_STUDENT, minSeats: 1, academic: true };
  }
  return { priceId: env.STRIPE_PRICE_ID_PRO, minSeats: 1, academic: false };
}

export interface StripeCustomer {
  id: string;
  email: string | null;
}

export async function createOrGetCustomer(
  secretKey: string,
  email: string,
  organizationId: string,
): Promise<StripeCustomer> {
  // Search for an existing customer with this email + org metadata
  const search = await stripeFetch<{ data: StripeCustomer[] }>(
    secretKey,
    `/customers?email=${encodeURIComponent(email)}&limit=1`,
  );
  if (search.data && search.data.length > 0) {
    return search.data[0];
  }
  return stripeFetch<StripeCustomer>(secretKey, `/customers`, {
    email,
    "metadata[organization_id]": organizationId,
  });
}

export interface CheckoutSession {
  id: string;
  url: string;
}

export async function createCheckoutSession(
  secretKey: string,
  params: {
    customerId: string;
    priceId: string;
    quantity?: number;
    // If true, we let the customer tweak the quantity inside the Checkout
    // session itself (e.g. change the seat count before paying).
    adjustableQuantity?: boolean;
    /** Floor for the Checkout quantity picker (Team's seat minimum). */
    minQuantity?: number;
    successUrl: string;
    cancelUrl: string;
    organizationId: string;
  },
): Promise<CheckoutSession> {
  const body: Record<string, string | number> = {
    customer: params.customerId,
    mode: "subscription",
    "line_items[0][price]": params.priceId,
    "line_items[0][quantity]": params.quantity ?? 1,
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    "metadata[organization_id]": params.organizationId,
    "subscription_data[metadata][organization_id]": params.organizationId,
    allow_promotion_codes: "true",
    billing_address_collection: "auto",
  };
  if (params.adjustableQuantity) {
    body["line_items[0][adjustable_quantity][enabled]"] = "true";
    // Without this the customer could drop the picker back to 1 inside
    // Checkout and buy a single-seat "team" anyway — which is exactly what
    // both historical Team subscriptions did.
    body["line_items[0][adjustable_quantity][minimum]"] = params.minQuantity ?? 1;
    body["line_items[0][adjustable_quantity][maximum]"] = 999;
  }
  return stripeFetch<CheckoutSession>(secretKey, `/checkout/sessions`, body);
}

export interface PortalSession {
  id: string;
  url: string;
}

export async function createPortalSession(
  secretKey: string,
  params: { customerId: string; returnUrl: string },
): Promise<PortalSession> {
  return stripeFetch<PortalSession>(secretKey, `/billing_portal/sessions`, {
    customer: params.customerId,
    return_url: params.returnUrl,
  });
}

// Stripe webhook signatures: "t=TIMESTAMP,v1=SIG1,v1=SIG2,..."
// Verify by computing HMAC-SHA256 over `${timestamp}.${rawBody}` and
// checking that at least one of the v1 signatures matches in constant time.
export async function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds = 300,
): Promise<boolean> {
  const parts = signatureHeader.split(",").map((p) => p.trim());
  const kv = new Map<string, string[]>();
  for (const part of parts) {
    const [k, v] = part.split("=");
    if (!k || !v) continue;
    const arr = kv.get(k) || [];
    arr.push(v);
    kv.set(k, arr);
  }
  const timestamp = kv.get("t")?.[0];
  const signatures = kv.get("v1") || [];
  if (!timestamp || signatures.length === 0) return false;

  // Timestamp freshness check (prevents replay)
  const t = Number(timestamp);
  if (!Number.isFinite(t)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > toleranceSeconds) return false;

  const payload = `${timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  const expected = bufferToHex(mac);

  for (const sig of signatures) {
    if (constantTimeEquals(sig, expected)) return true;
  }
  return false;
}

function bufferToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
