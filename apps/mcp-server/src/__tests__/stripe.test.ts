import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createOrGetCustomer,
  customerOwnership,
  getCustomer,
  verifyWebhookSignature,
} from "../services/stripe.js";

// Compute a valid Stripe signature the same way Stripe does, so we can
// exercise the verifier without needing real Stripe traffic.
async function signStripePayload(
  secret: string,
  body: string,
  timestamp: number,
): Promise<string> {
  const payload = `${timestamp}.${body}`;
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
  return `t=${timestamp},v1=${hex}`;
}

describe("verifyWebhookSignature", () => {
  const secret = "whsec_test_abc123";
  const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });

  it("accepts a fresh, correctly signed payload", async () => {
    const now = Math.floor(Date.now() / 1000);
    const header = await signStripePayload(secret, body, now);
    expect(await verifyWebhookSignature(body, header, secret)).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const now = Math.floor(Date.now() / 1000);
    const header = await signStripePayload(secret, body, now);
    const tampered = body.replace("evt_1", "evt_2");
    expect(await verifyWebhookSignature(tampered, header, secret)).toBe(false);
  });

  it("rejects a payload signed with a different secret", async () => {
    const now = Math.floor(Date.now() / 1000);
    const header = await signStripePayload("whsec_wrong", body, now);
    expect(await verifyWebhookSignature(body, header, secret)).toBe(false);
  });

  it("rejects a stale timestamp (replay protection)", async () => {
    const stale = Math.floor(Date.now() / 1000) - 10 * 60; // 10 minutes ago
    const header = await signStripePayload(secret, body, stale);
    expect(await verifyWebhookSignature(body, header, secret)).toBe(false);
  });

  it("rejects a malformed signature header", async () => {
    expect(await verifyWebhookSignature(body, "garbage", secret)).toBe(false);
    expect(await verifyWebhookSignature(body, "", secret)).toBe(false);
  });

  it("accepts when one of multiple v1 signatures matches (secret rotation)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const good = await signStripePayload(secret, body, now);
    const goodHex = good.split("v1=")[1];
    const header = `t=${now},v1=0000000000000000000000000000000000000000000000000000000000000000,v1=${goodHex}`;
    expect(await verifyWebhookSignature(body, header, secret)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createOrGetCustomer: a customer is this org's only when it carries the org's
// metadata stamp. Email is caller-controlled and not unique in Stripe, so an
// email match alone handed one org another org's customer, and with it the
// billing portal (engram#443).
// ---------------------------------------------------------------------------

type ListedCustomer = { id: string; email: string | null; metadata?: Record<string, string> };

/**
 * Stand in for Stripe: the customer list returns `listed` for any email, and
 * a create echoes the form body back as a customer. Every call is recorded.
 */
function stubStripe(listed: ListedCustomer[]) {
  const calls: Array<{ method: string; url: string; form: URLSearchParams }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const raw = init?.body;
      const form = new URLSearchParams(
        raw instanceof URLSearchParams ? raw.toString() : typeof raw === "string" ? raw : "",
      );
      calls.push({ method, url, form });
      if (method === "GET" && url.startsWith("https://api.stripe.com/v1/customers?")) {
        return new Response(JSON.stringify({ object: "list", data: listed }), { status: 200 });
      }
      if (method === "POST" && url === "https://api.stripe.com/v1/customers") {
        return new Response(
          JSON.stringify({
            id: "cus_created",
            email: form.get("email"),
            metadata: { organization_id: form.get("metadata[organization_id]") },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: { message: `unexpected ${method} ${url}` } }), {
        status: 500,
      });
    }),
  );
  return calls;
}

describe("createOrGetCustomer: ownership (engram#443)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const email = "shared@example.com";

  it("does not reuse another org's customer that shares the email", async () => {
    const calls = stubStripe([
      { id: "cus_theirs", email, metadata: { organization_id: "org_them" } },
    ]);
    const customer = await createOrGetCustomer("sk_test_x", email, "org_me");
    expect(customer.id).toBe("cus_created");
    expect(customer.metadata?.organization_id).toBe("org_me");
    const post = calls.find((c) => c.method === "POST");
    expect(post).toBeDefined();
    expect(post!.form.get("email")).toBe(email);
    expect(post!.form.get("metadata[organization_id]")).toBe("org_me");
  });

  it("reuses the customer stamped with this org's id, without creating one", async () => {
    const calls = stubStripe([
      { id: "cus_theirs", email, metadata: { organization_id: "org_them" } },
      { id: "cus_mine", email, metadata: { organization_id: "org_me" } },
    ]);
    const customer = await createOrGetCustomer("sk_test_x", email, "org_me");
    expect(customer.id).toBe("cus_mine");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("does not reuse an unstamped customer, even when it is the only match", async () => {
    const calls = stubStripe([{ id: "cus_unstamped", email }]);
    const customer = await createOrGetCustomer("sk_test_x", email, "org_me");
    expect(customer.id).toBe("cus_created");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("lists by the encoded email with a page large enough to find the stamp", async () => {
    const calls = stubStripe([]);
    await createOrGetCustomer("sk_test_x", "a+b@example.com", "org_me");
    const list = calls.find((c) => c.method === "GET");
    expect(list).toBeDefined();
    const url = new URL(list!.url);
    expect(url.pathname).toBe("/v1/customers");
    expect(url.searchParams.get("email")).toBe("a+b@example.com");
    expect(Number(url.searchParams.get("limit"))).toBeGreaterThanOrEqual(100);
  });

  it("refuses to run without an organization id to stamp", async () => {
    const calls = stubStripe([]);
    await expect(createOrGetCustomer("sk_test_x", email, "")).rejects.toThrow(/organizationId/);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getCustomer / customerOwnership: the cached-id half of engram#443. A cached
// customer is trusted only after Stripe confirms it still exists and carries
// this org's stamp.
// ---------------------------------------------------------------------------

describe("getCustomer / customerOwnership (engram#443)", () => {
  afterEach(() => vi.unstubAllGlobals());

  function answer(status: number, body: unknown) {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        urls.push(String(input));
        return { ok: status >= 200 && status < 300, status, json: async () => body };
      }),
    );
    return urls;
  }

  it("returns the customer Stripe has", async () => {
    const urls = answer(200, {
      id: "cus_1",
      email: "a@example.com",
      metadata: { organization_id: "org_a" },
    });
    const got = await getCustomer("sk_test", "cus_1");
    expect(got).toMatchObject({ id: "cus_1", metadata: { organization_id: "org_a" } });
    expect(urls).toEqual(["https://api.stripe.com/v1/customers/cus_1"]);
  });

  it("encodes the id in the path", async () => {
    const urls = answer(200, { id: "x", metadata: {} });
    await getCustomer("sk_test", "cus_1/../2?x=1");
    expect(urls[0]).toBe(
      `https://api.stripe.com/v1/customers/${encodeURIComponent("cus_1/../2?x=1")}`,
    );
  });

  it("is null for an id Stripe does not know (404)", async () => {
    answer(404, { error: { message: "No such customer" } });
    expect(await getCustomer("sk_test", "cus_gone")).toBeNull();
  });

  it("is null for a deleted customer (200 with deleted: true)", async () => {
    answer(200, { id: "cus_del", object: "customer", deleted: true });
    expect(await getCustomer("sk_test", "cus_del")).toBeNull();
  });

  it("throws on any other failure instead of calling the customer missing", async () => {
    answer(500, { error: { message: "upstream" } });
    await expect(getCustomer("sk_test", "cus_1")).rejects.toThrow(/^stripe: upstream/);
    answer(401, {});
    await expect(getCustomer("sk_test", "cus_1")).rejects.toThrow(/^stripe: Stripe API 401/);
  });

  it("ownership is decided by the stamp alone", () => {
    const base = { id: "cus_1", email: "shared@example.com" };
    expect(customerOwnership({ ...base, metadata: { organization_id: "org_a" } }, "org_a")).toBe("own");
    expect(customerOwnership({ ...base, metadata: { organization_id: "org_b" } }, "org_a")).toBe("foreign");
    expect(customerOwnership({ ...base, metadata: {} }, "org_a")).toBe("unstamped");
    expect(customerOwnership(base, "org_a")).toBe("unstamped");
    expect(customerOwnership({ ...base, metadata: { organization_id: "" } }, "org_a")).toBe("unstamped");
  });
});
