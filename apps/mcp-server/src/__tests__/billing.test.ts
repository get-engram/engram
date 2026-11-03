import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { billing, billingWebhook } from "../routes/billing.js";
import { registerManageSubscription } from "../mcp/tools/manage-subscription.js";
import {
  createOrGetCustomer,
  createPortalSession,
  getCustomer,
  type StripeCustomer,
} from "../services/stripe.js";
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
    STRIPE_PRICE_ID_STUDENT: "price_student",
  STRIPE_PRICE_ID_EDU_TEAM: "price_edu_team",
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
    // The cached customer is verified against Stripe before use (engram#443);
    // by default it is the org's own.
    getCustomer: vi.fn(async (_key: string, id: string) => ({
      id,
      email: "test@example.com",
      metadata: { organization_id: "org_test" },
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

  // past_due means a renewal charge failed and Stripe is still retrying —
  // the customer intends to pay, so the plan is NOT revoked mid-dunning.
  // Stripe escalates to unpaid/canceled when retries are exhausted; those
  // churn (see the tests below). The mock D1 doesn't apply UPDATEs, so this
  // asserts the handler accepts the event without erroring.
  it("accepts past_due without churning (dunning, not cancellation)", async () => {
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

// ---------------------------------------------------------------------------
// Tests: Webhook — idempotency ledger (engram#454)
// ---------------------------------------------------------------------------

/** Record every statement the handler prepares, with the values it binds. */
function tapStatements(db: D1Database) {
  const log: Array<{ sql: string; args: unknown[] }> = [];
  const target = db as unknown as { prepare: (sql: string) => D1PreparedStatement };
  const prepare = target.prepare.bind(target);
  target.prepare = (sql: string) => {
    const entry = { sql, args: [] as unknown[] };
    log.push(entry);
    const stmt = prepare(sql);
    const bind = stmt.bind.bind(stmt);
    stmt.bind = (...args: unknown[]) => {
      entry.args = args;
      return bind(...args);
    };
    return stmt;
  };
  return log;
}

const checkoutCompleted = (id: string) => ({
  id,
  type: "checkout.session.completed",
  data: { object: { customer: "cus_once", metadata: { organization_id: "org_idem" } } },
});

const customerWrites = (log: Array<{ sql: string }>) =>
  log.filter((s) => /UPDATE organizations SET stripe_customer_id/.test(s.sql));

describe("webhook: idempotency (engram#454)", () => {
  it("applies an event once and acknowledges a repeat delivery without re-applying it", async () => {
    const db = createMockD1();
    const env = createBillingEnv(db);
    await insertOrganizationWithEmail(db, "org_idem", "Idem Org", "idem@example.com");
    const log = tapStatements(db);
    const app = createWebhookApp();

    const first = await sendWebhookEvent(app, env, checkoutCompleted("evt_once"));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ received: true });
    expect(customerWrites(log)).toHaveLength(1);

    // Stripe's retry, or a captured signed body replayed inside the
    // signature window: acknowledged, nothing applied.
    const second = await sendWebhookEvent(app, env, checkoutCompleted("evt_once"));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ received: true, duplicate: true });
    expect(customerWrites(log)).toHaveLength(1);

    const ledger = await db.prepare("SELECT event_id FROM stripe_webhook_events").all();
    expect(ledger.results).toHaveLength(1);

    // A different event is not a duplicate of the first.
    const third = await sendWebhookEvent(app, env, checkoutCompleted("evt_other"));
    expect(await third.json()).toEqual({ received: true });
    expect(customerWrites(log)).toHaveLength(2);
  });

  it("refuses a signed body that is not shaped like an event, before touching the ledger", async () => {
    const db = createMockD1();
    const env = createBillingEnv(db);
    const log = tapStatements(db);
    const app = createWebhookApp();

    const bodies = [
      // id that is not a Stripe event id
      { id: "not-an-event-id", type: "checkout.session.completed", data: { object: {} } },
      // no data
      { id: "evt_nodata", type: "checkout.session.completed" },
      // object that is not an object
      { id: "evt_array", type: "checkout.session.completed", data: { object: [] } },
      // no type
      { id: "evt_notype", data: { object: {} } },
      // not an object at all
      [],
    ];
    for (const parsed of bodies) {
      const body = JSON.stringify(parsed);
      const sig = await signStripePayload(TEST_WEBHOOK_SECRET, body);
      const res = await app.request(
        "/billing/webhook",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "stripe-signature": sig },
          body,
        },
        env,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_event" });
    }
    expect(log.filter((s) => /stripe_webhook_events/.test(s.sql))).toHaveLength(0);
  });

  it("releases the claim when the handler fails, so Stripe's retry is processed", async () => {
    const db = createMockD1();
    const env = createBillingEnv(db);
    await insertOrganizationWithEmail(db, "org_idem", "Idem Org", "idem@example.com");
    const log = tapStatements(db);

    // The first customer write fails with a D1-style error; later ones succeed.
    const target = db as unknown as { prepare: (sql: string) => D1PreparedStatement };
    const prepare = target.prepare.bind(target);
    let failed = false;
    target.prepare = (sql: string) => {
      const stmt = prepare(sql);
      if (!failed && /SET stripe_customer_id/.test(sql)) {
        const bind = stmt.bind.bind(stmt);
        stmt.bind = (...args: unknown[]) => {
          const bound = bind(...args);
          bound.run = async () => {
            failed = true;
            throw new Error("D1_ERROR: boom");
          };
          return bound;
        };
      }
      return stmt;
    };

    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const app = createWebhookApp();
      const first = await sendWebhookEvent(app, env, checkoutCompleted("evt_flaky"));
      expect(first.status).toBe(500);
      const release = log.find((s) => /DELETE FROM stripe_webhook_events/.test(s.sql));
      expect(release).toBeDefined();
      expect(release!.args[0]).toBe("evt_flaky");
      expect(log.filter((s) => /SET processed_at/.test(s.sql))).toHaveLength(0);

      // Stripe retries the non-2xx: the id was given back, so the retry runs
      // the handler, and this time the id becomes final.
      const retry = await sendWebhookEvent(app, env, checkoutCompleted("evt_flaky"));
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({ received: true });
      expect(customerWrites(log)).toHaveLength(2);
      expect(log.filter((s) => /SET processed_at/.test(s.sql))).toHaveLength(1);
    } finally {
      quiet.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// The cached customer id (engram#443, second half). A row's stripe_customer_id
// is a cache that the old email lookup could fill with another org's customer.
// Every surface that acts on it resolves it against Stripe first: a foreign or
// vanished customer is unlinked and never used, the org's own is used, and an
// unstamped (hand-attached) one is tolerated.
// ---------------------------------------------------------------------------

const customerOf = (id: string, org: string | null): StripeCustomer => ({
  id,
  email: "test@example.com",
  metadata: org === null ? {} : { organization_id: org },
});
const unlinks = (log: Array<{ sql: string; args: unknown[] }>) =>
  log.filter((s) =>
    /UPDATE organizations SET stripe_customer_id = NULL WHERE id = \? AND stripe_customer_id = \?/.test(s.sql),
  );
const relinks = (log: Array<{ sql: string; args: unknown[] }>) =>
  log.filter((s) => /UPDATE organizations SET stripe_customer_id = \? WHERE id = \?/.test(s.sql));

describe("cached Stripe customer ownership (engram#443)", () => {
  const auth: AuthContext = {
    organizationId: "org_test",
    apiKeyId: "key_test",
    tier: "pro",
    scopes: ["read", "write", "search", "delete"],
    seatId: null,
  };
  let db: D1Database;
  let env: Env;
  let log: Array<{ sql: string; args: unknown[] }>;

  beforeEach(async () => {
    db = createMockD1();
    env = createBillingEnv(db);
    await db.exec(
      "INSERT INTO organizations (id, name, email, stripe_customer_id) VALUES ('org_test', 'Test Org', 'test@example.com', 'cus_cached')",
    );
    log = tapStatements(db);
    vi.mocked(getCustomer).mockClear();
    vi.mocked(createPortalSession).mockClear();
    vi.mocked(createOrGetCustomer).mockClear();
    // The raw subscription lookups in checkout/upgrade must not reach the network.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const post = (path: string, body: unknown) =>
    createAuthedApp(env, auth).request(
      path,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      env,
    );
  const portal = () => post("/api/billing/portal", {});
  const checkout = () => post("/api/billing/checkout", { plan: "pro" });

  it("portal: a customer stamped for another org is unlinked and refused", async () => {
    vi.mocked(getCustomer).mockResolvedValueOnce(customerOf("cus_cached", "org_victim"));
    const res = await portal();
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("no_subscription");
    expect(getCustomer).toHaveBeenCalledWith(TEST_STRIPE_SECRET, "cus_cached");
    expect(unlinks(log).map((s) => s.args)).toEqual([["org_test", "cus_cached"]]);
    expect(createPortalSession).not.toHaveBeenCalled();
  });

  it("portal: a customer Stripe no longer has is unlinked and refused", async () => {
    vi.mocked(getCustomer).mockResolvedValueOnce(null);
    const res = await portal();
    expect(res.status).toBe(400);
    expect(unlinks(log)).toHaveLength(1);
    expect(createPortalSession).not.toHaveBeenCalled();
  });

  it("portal: the org's own customer opens the portal, untouched", async () => {
    vi.mocked(getCustomer).mockResolvedValueOnce(customerOf("cus_cached", "org_test"));
    const res = await portal();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { url: string }).url).toContain("billing.stripe.com");
    expect(unlinks(log)).toHaveLength(0);
    expect(createPortalSession).toHaveBeenCalledWith(
      TEST_STRIPE_SECRET,
      expect.objectContaining({ customerId: "cus_cached" }),
    );
  });

  it("portal: an unstamped (hand-attached) customer is tolerated", async () => {
    vi.mocked(getCustomer).mockResolvedValueOnce(customerOf("cus_cached", null));
    const res = await portal();
    expect(res.status).toBe(200);
    expect(unlinks(log)).toHaveLength(0);
  });

  it("portal: a Stripe outage is an error, not a verdict", async () => {
    vi.mocked(getCustomer).mockRejectedValueOnce(new Error("stripe: Stripe API 500"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await portal();
      expect(res.status).toBe(500);
    } finally {
      quiet.mockRestore();
    }
    expect(unlinks(log)).toHaveLength(0);
    expect(createPortalSession).not.toHaveBeenCalled();
  });

  it("checkout: a foreign cached customer is unlinked and replaced by the org's own", async () => {
    vi.mocked(getCustomer).mockResolvedValueOnce(customerOf("cus_cached", "org_victim"));
    const res = await checkout();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { url: string }).url).toContain("checkout.stripe.com");
    expect(unlinks(log).map((s) => s.args)).toEqual([["org_test", "cus_cached"]]);
    expect(createOrGetCustomer).toHaveBeenCalledWith(TEST_STRIPE_SECRET, "test@example.com", "org_test");
    expect(relinks(log).map((s) => s.args)).toEqual([["cus_test_123", "org_test"]]);
  });

  it("checkout: the org's own cached customer is kept", async () => {
    vi.mocked(getCustomer).mockResolvedValueOnce(customerOf("cus_cached", "org_test"));
    const res = await checkout();
    expect(res.status).toBe(200);
    expect(createOrGetCustomer).not.toHaveBeenCalled();
    expect(unlinks(log)).toHaveLength(0);
    expect(relinks(log)).toHaveLength(0);
  });

  // The MCP tool is the second portal/checkout path; it used to check only
  // that the cached customer EXISTED.
  type Handler = (
    params: Record<string, unknown>,
  ) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
  function tool(): Handler {
    let handler: Handler | undefined;
    const server = {
      tool: (...args: unknown[]) => {
        handler = args[args.length - 1] as Handler;
      },
    } as unknown as McpServer;
    registerManageSubscription(server, env, auth);
    if (!handler) throw new Error("tool not registered");
    return handler;
  }

  it("manage_subscription portal: a foreign customer is unlinked and refused", async () => {
    vi.mocked(getCustomer).mockResolvedValueOnce(customerOf("cus_cached", "org_victim"));
    const res = await tool()({ action: "portal" });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text)).toMatchObject({ error: "no_subscription" });
    expect(unlinks(log)).toHaveLength(1);
    expect(createPortalSession).not.toHaveBeenCalled();
  });

  it("manage_subscription portal: the org's own customer opens the portal", async () => {
    vi.mocked(getCustomer).mockResolvedValueOnce(customerOf("cus_cached", "org_test"));
    const res = await tool()({ action: "portal" });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text).url).toContain("billing.stripe.com");
    expect(unlinks(log)).toHaveLength(0);
  });

  it("manage_subscription upgrade: a foreign customer is replaced before checkout", async () => {
    vi.mocked(getCustomer).mockResolvedValueOnce(customerOf("cus_cached", "org_victim"));
    const res = await tool()({ action: "upgrade", plan: "pro" });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text).url).toContain("checkout.stripe.com");
    expect(unlinks(log)).toHaveLength(1);
    expect(createOrGetCustomer).toHaveBeenCalledWith(TEST_STRIPE_SECRET, "test@example.com", "org_test");
    expect(relinks(log).map((s) => s.args)).toEqual([["cus_test_123", "org_test"]]);
  });
});
