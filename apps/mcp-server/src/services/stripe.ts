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
    body["line_items[0][adjustable_quantity][minimum]"] = 1;
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
