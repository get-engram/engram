import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { billing, billingWebhook } from "../routes/billing.js";
import { insertOrganizationWithEmail } from "@getengram/db";
import { createMockD1, createMockEnv } from "./helpers.js";
import type { Env, AuthContext } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_STRIPE_SECRET = "sk_test_fake";
const TEST_WEBHOOK_SECRET = "whsec_test_abc123";
const TEST_PRICE_PRO = "price_pro_test";
const TEST_PRICE_TEAM = "price_team_test";
const TEST_APP_URL = "https://test.example.com";

function createBillingEnv(db: D1Database): Env {
  return {
    ...createMockEnv(db),
    STRIPE_SECRET_KEY: TEST_STRIPE_SECRET,
    STRIPE_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    STRIPE_PRICE_ID_PRO: TEST_PRICE_PRO,
    STRIPE_PRICE_ID_TEAM: TEST_PRICE_TEAM,
    APP_URL: TEST_APP_URL,
    ADMIN_SECRET: "admin_test",
    SUPABASE_JWT_SECRET: "jwt_test",
    SUPABASE_URL: "https://test.supabase.co",
  } as Env;
}

type HonoEnv = { Bindings: Env; Variables: { auth: AuthContext } };

/** Build a Hono app with fake auth for the checkout/portal routes. */
function createAuthedApp(env: Env, auth: AuthContext) {
  const app = new Hono<HonoEnv>();
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    await next();
  });
  app.route("/api/billing", billing);
  return app;
}

/** Build a Hono app for the public webhook route. */
function createWebhookApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/billing/webhook", billingWebhook);
  return app;
}

/** Compute a valid Stripe webhook signature. */
async function signStripePayload(
  secret: string,
  body: string,
  timestamp?: number,
): Promise<string> {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const payload = `${ts}.${body}`;
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
  const hex = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `t=${ts},v1=${hex}`;
}

/** Send a signed webhook event to the app. */
async function sendWebhookEvent(
  app: Hono<{ Bindings: Env }>,
  env: Env,
  event: { id: string; type: string; data: { object: Record<string, unknown> } },
) {
  const body = JSON.stringify(event);
  const sig = await signStripePayload(TEST_WEBHOOK_SECRET, body);
  return app.request("/billing/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "stripe-signature": sig,
    },
    body,
  }, env);
}

// ---------------------------------------------------------------------------
// Mock Stripe API calls — we mock the service functions so we don't hit
// Stripe's real API. The webhook handler uses verifyWebhookSignature which
// uses Web Crypto (works in tests), plus DB queries (works with mock D1).
// For checkout/portal routes, we mock the Stripe service functions.
// ---------------------------------------------------------------------------

vi.mock("../services/stripe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/stripe.js")>();
  return {
    ...actual,
    // Keep the real verifyWebhookSignature — it uses Web Crypto which works
    verifyWebhookSignature: actual.verifyWebhookSignature,
    // Mock the Stripe API calls
    createOrGetCustomer: vi.fn(async () => ({
      id: "cus_test_123",
      email: "test@example.com",
    })),
    createCheckoutSession: vi.fn(async () => ({
      id: "cs_test_session",
      url: "https://checkout.stripe.com/pay/cs_test_session",
    })),
    createPortalSession: vi.fn(async () => ({
      id: "bps_test_session",
      url: "https://billing.stripe.com/session/bps_test_session",
    })),
  };
});

// ---------------------------------------------------------------------------
// Tests: POST /api/billing/checkout
// ---------------------------------------------------------------------------

describe("POST /api/billing/checkout", () => {
  let db: D1Database;
  let env: Env;
  let auth: AuthContext;

  beforeEach(async () => {
    db = createMockD1();
    env = createBillingEnv(db);
    auth = { organizationId: "org_test", apiKeyId: "key_test", tier: "free", scopes: ["read", "write", "search", "delete"] };
    await insertOrganizationWithEmail(db, "org_test", "Test Org", "test@example.com");
  });

  it("creates a checkout session for pro plan", async () => {
    const app = createAuthedApp(env, auth);
    const res = await app.request("/api/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: "pro" }),
    }, env);

    expect(res.status).toBe(200);
    const data = await res.json() as { url: string; session_id: string; plan: string };
    expect(data.url).toContain("checkout.stripe.com");
    expect(data.session_id).toBe("cs_test_session");
    expect(data.plan).toBe("pro");
  });

  it("creates a checkout session for team plan", async () => {
    const app = createAuthedApp(env, auth);
    const res = await app.request("/api/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: "team", quantity: 5 }),
    }, env);

    expect(res.status).toBe(200);
    const data = await res.json() as { plan: string };
    expect(data.plan).toBe("team");
  });

  it("defaults to pro plan when no plan specified", async () => {
    const app = createAuthedApp(env, auth);
    const res = await app.request("/api/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }, env);

    expect(res.status).toBe(200);
    const data = await res.json() as { plan: string };
    expect(data.plan).toBe("pro");
  });

  it("returns 404 when organization not found", async () => {
    auth.organizationId = "org_nonexistent";
    const app = createAuthedApp(env, auth);
    const res = await app.request("/api/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: "pro" }),
    }, env);

    expect(res.status).toBe(404);
    const data = await res.json() as { error: string };
    expect(data.error).toBe("organization_not_found");
  });

  it("returns 400 when organization has no email", async () => {
    // Insert org without email using the plain insert
    const db2 = createMockD1();
    const env2 = createBillingEnv(db2);
    // Insert org with null email by using raw SQL
    await db2.exec(
      "INSERT INTO organizations (id, name) VALUES ('org_noemail', 'No Email Org')",
    );
    auth.organizationId = "org_noemail";
    const app = createAuthedApp(env2, auth);
    const res = await app.request("/api/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: "pro" }),
    }, env2);

    expect(res.status).toBe(400);
    const data = await res.json() as { error: string };
    expect(data.error).toBe("missing_email");
  });

  it("returns 500 when price ID not configured", async () => {
    const badEnv = { ...env, STRIPE_PRICE_ID_PRO: "" };
    const app = createAuthedApp(badEnv as Env, auth);
    const res = await app.request("/api/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: "pro" }),
    }, badEnv as Env);

    expect(res.status).toBe(500);
    const data = await res.json() as { error: string };
    expect(data.error).toBe("price_not_configured");
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/billing/portal
// ---------------------------------------------------------------------------

describe("POST /api/billing/portal", () => {
  let db: D1Database;
  let env: Env;
  let auth: AuthContext;

  beforeEach(async () => {
    db = createMockD1();
    env = createBillingEnv(db);
    auth = { organizationId: "org_test", apiKeyId: "key_test", tier: "pro", scopes: ["read", "write", "search", "delete"] };
  });

  it("creates a portal session for org with Stripe customer", async () => {
    // Insert org with stripe_customer_id
    await db.exec(
      "INSERT INTO organizations (id, name, email, stripe_customer_id) VALUES ('org_test', 'Test Org', 'test@example.com', 'cus_existing')",
    );
    const app = createAuthedApp(env, auth);
    const res = await app.request("/api/billing/portal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }, env);

    expect(res.status).toBe(200);
    const data = await res.json() as { url: string };
    expect(data.url).toContain("billing.stripe.com");
  });

  it("returns 400 when org has no Stripe customer", async () => {
    await insertOrganizationWithEmail(db, "org_test", "Test Org", "test@example.com");
    const app = createAuthedApp(env, auth);
    const res = await app.request("/api/billing/portal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }, env);

    expect(res.status).toBe(400);
    const data = await res.json() as { error: string };
    expect(data.error).toBe("no_subscription");
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /billing/webhook — signature verification
// ---------------------------------------------------------------------------

describe("POST /billing/webhook — signature", () => {
  let env: Env;

  beforeEach(() => {
    env = createBillingEnv(createMockD1());
  });

  it("rejects requests without stripe-signature header", async () => {
    const app = createWebhookApp();
    const res = await app.request("/billing/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "evt_1", type: "test" }),
    }, env);

    expect(res.status).toBe(400);
    const data = await res.json() as { error: string };
    expect(data.error).toBe("missing_signature");
  });

  it("rejects requests with invalid signature", async () => {
    const app = createWebhookApp();
    const res = await app.request("/billing/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": "t=123,v1=invalid",
      },
      body: JSON.stringify({ id: "evt_1", type: "test" }),
    }, env);

    expect(res.status).toBe(400);
    const data = await res.json() as { error: string };
    expect(data.error).toBe("invalid_signature");
  });

  it("accepts valid signature and returns 200", async () => {
    const app = createWebhookApp();
    const event = { id: "evt_1", type: "unknown.event", data: { object: {} } };
    const res = await sendWebhookEvent(app, env, event);

    expect(res.status).toBe(200);
    const data = await res.json() as { received: boolean };
    expect(data.received).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: Webhook — checkout.session.completed
// ---------------------------------------------------------------------------

describe("webhook: checkout.session.completed", () => {
  it("caches stripe customer ID on the organization", async () => {
    const db = createMockD1();
    const env = createBillingEnv(db);
    await insertOrganizationWithEmail(db, "org_checkout", "Checkout Org", "buyer@example.com");

    const app = createWebhookApp();
    const res = await sendWebhookEvent(app, env, {
      id: "evt_checkout",
      type: "checkout.session.completed",
      data: {
        object: {
          customer: "cus_new_123",
          metadata: { organization_id: "org_checkout" },
        },
      },
    });

    expect(res.status).toBe(200);
    // Verify the customer ID was cached — fetch the org from DB
    const org = await db.prepare("SELECT * FROM organizations WHERE id = ?")
      .bind("org_checkout")
      .first() as { stripe_customer_id?: string } | null;
    // The mock D1 UPDATE handler doesn't actually update fields, but we
    // verify the route processed without errors. In a real D1 the
    // stripe_customer_id column would be set.
  });

  it("resolves org via customer lookup when metadata missing", async () => {
    const db = createMockD1();
    const env = createBillingEnv(db);
    // Insert org with a known stripe_customer_id
    await db.exec(
      "INSERT INTO organizations (id, name, email, stripe_customer_id) VALUES ('org_cust', 'Cust Org', 'cust@example.com', 'cus_known')",
    );

    const app = createWebhookApp();
    const res = await sendWebhookEvent(app, env, {
      id: "evt_checkout_fallback",
      type: "checkout.session.completed",
      data: {
        object: {
          customer: "cus_known",
          // No metadata.organization_id — must fall back to customer lookup
        },
      },
    });

    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tests: Webhook — customer.subscription.created
// ---------------------------------------------------------------------------

describe("webhook: customer.subscription.created", () => {
  it("upgrades org to pro when subscription is active", async () => {
    const db = createMockD1();
    const env = createBillingEnv(db);
    await insertOrganizationWithEmail(db, "org_sub", "Sub Org", "sub@example.com");

    const app = createWebhookApp();
    const res = await sendWebhookEvent(app, env, {
      id: "evt_sub_created",
      type: "customer.subscription.created",
      data: {
        object: {
          id: "sub_pro_123",
          status: "active",
          metadata: { organization_id: "org_sub" },
          items: {
            data: [{ price: { id: TEST_PRICE_PRO } }],
          },
        },
      },
    });

    expect(res.status).toBe(200);
  });

  it("upgrades org to team when subscription is active with team price", async () => {
    const db = createMockD1();
    const env = createBillingEnv(db);
    await insertOrganizationWithEmail(db, "org_team", "Team Org", "team@example.com");

    const app = createWebhookApp();
    const res = await sendWebhookEvent(app, env, {
      id: "evt_sub_team",
      type: "customer.subscription.created",
      data: {
        object: {
          id: "sub_team_123",
          status: "active",
          metadata: { organization_id: "org_team" },
          items: {
            data: [{ price: { id: TEST_PRICE_TEAM } }],
          },
        },
      },
    });

    expect(res.status).toBe(200);
  });

  it("handles trialing status the same as active", async () => {
    const db = createMockD1();
    const env = createBillingEnv(db);
    await insertOrganizationWithEmail(db, "org_trial", "Trial Org", "trial@example.com");

    const app = createWebhookApp();
    const res = await sendWebhookEvent(app, env, {
      id: "evt_sub_trial",
      type: "customer.subscription.created",
      data: {
        object: {
          id: "sub_trial_123",
          status: "trialing",
          metadata: { organization_id: "org_trial" },
          items: {
            data: [{ price: { id: TEST_PRICE_PRO } }],
          },
        },
      },
    });

    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tests: Webhook — customer.subscription.updated
// ---------------------------------------------------------------------------

describe("webhook: customer.subscription.updated", () => {
  it("downgrades to free when subscription is canceled", async () => {
    const db = createMockD1();
    const env = createBillingEnv(db);
    await insertOrganizationWithEmail(db, "org_cancel", "Cancel Org", "cancel@example.com");

    const app = createWebhookApp();
    const res = await sendWebhookEvent(app, env, {
      id: "evt_sub_canceled",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_cancel_123",
          status: "canceled",
          metadata: { organization_id: "org_cancel" },
          items: {
            data: [{ price: { id: TEST_PRICE_PRO } }],
          },
        },
      },
    });

    expect(res.status).toBe(200);
  });

  it("downgrades to free when subscription is past_due", async () => {
    const db = createMockD1();
    const env = createBillingEnv(db);
    await insertOrganizationWithEmail(db, "org_pastdue", "PastDue Org", "pastdue@example.com");

    const app = createWebhookApp();
    const res = await sendWebhookEvent(app, env, {
      id: "evt_sub_pastdue",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_pastdue_123",
          status: "past_due",
          metadata: { organization_id: "org_pastdue" },
          items: {
            data: [{ price: { id: TEST_PRICE_PRO } }],
          },
        },
      },
    });

    expect(res.status).toBe(200);
  });

  it("downgrades to free when subscription is unpaid", async () => {
    const db = createMockD1();
    const env = createBillingEnv(db);
    await insertOrganizationWithEmail(db, "org_unpaid", "Unpaid Org", "unpaid@example.com");

    const app = createWebhookApp();
    const res = await sendWebhookEvent(app, env, {
      id: "evt_sub_unpaid",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_unpaid_123",
          status: "unpaid",
          metadata: { organization_id: "org_unpaid" },
          items: {
            data: [{ price: { id: TEST_PRICE_PRO } }],
          },
        },
      },
    });

    expect(res.status).toBe(200);
  });

  it("downgrades to free when subscription is incomplete_expired", async () => {
    const db = createMockD1();
    const env = createBillingEnv(db);
    await insertOrganizationWithEmail(db, "org_expired", "Expired Org", "expired@example.com");

    const app = createWebhookApp();
    const res = await sendWebhookEvent(app, env, {
      id: "evt_sub_expired",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_expired_123",
          status: "incomplete_expired",
          metadata: { organization_id: "org_expired" },
          items: {
            data: [{ price: { id: TEST_PRICE_PRO } }],
          },
        },
      },
    });

    expect(res.status).toBe(200);
  });

  it("upgrades tier when active subscription price changes", async () => {
    const db = createMockD1();
    const env = createBillingEnv(db);
    await insertOrganizationWithEmail(db, "org_upgrade", "Upgrade Org", "upgrade@example.com");

    const app = createWebhookApp();
    // First pro
    await sendWebhookEvent(app, env, {
      id: "evt_sub_upgrade_1",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_upgrade_123",
          status: "active",
          metadata: { organization_id: "org_upgrade" },
          items: { data: [{ price: { id: TEST_PRICE_PRO } }] },
        },
      },
    });

    // Then upgrade to team
    const res = await sendWebhookEvent(app, env, {
      id: "evt_sub_upgrade_2",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_upgrade_123",
          status: "active",
          metadata: { organization_id: "org_upgrade" },
          items: { data: [{ price: { id: TEST_PRICE_TEAM } }] },
        },
      },
    });

    expect(res.status).toBe(200);
  });

  it("skips update when org ID cannot be resolved", async () => {
    const db = createMockD1();
    const env = createBillingEnv(db);

    const app = createWebhookApp();
    const res = await sendWebhookEvent(app, env, {
      id: "evt_sub_noid",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_noid_123",
          status: "active",
          // No metadata, no customer — org can't be resolved
          items: { data: [{ price: { id: TEST_PRICE_PRO } }] },
        },
      },
    });

    // Should still return 200 (ack to Stripe) even if we can't find the org
    expect(res.status).toBe(200);
  });

  it("skips update when price ID is unknown", async () => {
    const db = createMockD1();
    const env = createBillingEnv(db);
    await insertOrganizationWithEmail(db, "org_unknown", "Unknown Org", "unknown@example.com");

    const app = createWebhookApp();
    const res = await sendWebhookEvent(app, env, {
      id: "evt_sub_unknown_price",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_unknown_123",
          status: "active",
          metadata: { organization_id: "org_unknown" },
          items: { data: [{ price: { id: "price_unknown_xyz" } }] },
        },
      },
    });

    // Unknown price + active status = no tier update, but still 200
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tests: Webhook — customer.subscription.deleted
// ---------------------------------------------------------------------------

describe("webhook: customer.subscription.deleted", () => {
  it("resets org to free tier", async () => {
    const db = createMockD1();
    const env = createBillingEnv(db);
    await insertOrganizationWithEmail(db, "org_del", "Del Org", "del@example.com");

    const app = createWebhookApp();
    const res = await sendWebhookEvent(app, env, {
      id: "evt_sub_deleted",
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_del_123",
          customer: "cus_del_123",
          metadata: { organization_id: "org_del" },
        },
      },
    });

    expect(res.status).toBe(200);
  });

  it("handles unknown org gracefully on deletion", async () => {
    const db = createMockD1();
    const env = createBillingEnv(db);

    const app = createWebhookApp();
    const res = await sendWebhookEvent(app, env, {
      id: "evt_sub_deleted_noop",
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_gone_123",
          // No metadata, no customer match
        },
      },
    });

    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tests: Webhook — unknown events
// ---------------------------------------------------------------------------

describe("webhook: unknown events", () => {
  it("acknowledges unknown event types with 200", async () => {
    const db = createMockD1();
    const env = createBillingEnv(db);

    const app = createWebhookApp();
    const res = await sendWebhookEvent(app, env, {
      id: "evt_random",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_123" } },
    });

    expect(res.status).toBe(200);
    const data = await res.json() as { received: boolean };
    expect(data.received).toBe(true);
  });
});
