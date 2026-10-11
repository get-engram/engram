import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { admin } from "../routes/admin.js";
import type { Env } from "../types.js";

/**
 * /admin/stripe/ensure-student-price writes to LIVE Stripe, so the one thing
 * that must hold is idempotency: a second call creates nothing. These tests
 * pin that, and that a permissions failure is reported rather than swallowed
 * (the Stripe CLI's restricted key lacking product_write is exactly why this
 * endpoint exists).
 */

function app(env: Partial<Env>) {
  const a = new Hono<{ Bindings: Env }>();
  a.route("/admin", admin);
  return {
    call: () => a.request("/admin/stripe/ensure-student-price", { method: "POST" }, env as Env),
  };
}

const PRICE = {
  id: "price_live_student",
  unit_amount: 300,
  currency: "usd",
  lookup_key: "student_monthly",
  active: true,
  livemode: true,
  product: "prod_x",
  recurring: { interval: "month" },
};

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const calls = () => fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit)?.method ?? "GET"} ${url}`);

describe("POST /admin/stripe/ensure-student-price", () => {
  it("returns the existing price and creates nothing", async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [PRICE] }));
    const res = await app({ STRIPE_SECRET_KEY: "sk_test", STRIPE_PRICE_ID_STUDENT: PRICE.id }).call();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      created: false,
      price_id: PRICE.id,
      unit_amount: 300,
      interval: "month",
      configured: true,
    });
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toMatch(/^GET .*\/prices\?lookup_keys\[\]=student_monthly/);
    expect(calls().some((c) => c.includes("/products"))).toBe(false);
  });

  it("reports configured:false when the price exists but the secret does not point at it", async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [PRICE] }));
    const res = await app({ STRIPE_SECRET_KEY: "sk_test" }).call();
    expect(await res.json()).toMatchObject({ created: false, configured: false });
  });

  it("creates product then price at $3/month with the tier metadata the webhook maps on", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ data: [] }))
      .mockResolvedValueOnce(json({ id: "prod_new" }))
      .mockResolvedValueOnce(json({ ...PRICE, id: "price_new", product: "prod_new" }));
    const res = await app({ STRIPE_SECRET_KEY: "sk_test" }).call();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      created: true,
      price_id: "price_new",
      unit_amount: 300,
      currency: "usd",
      interval: "month",
      next_step: "wrangler secret put STRIPE_PRICE_ID_STUDENT",
    });

    const [, productInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const product = new URLSearchParams(productInit.body as string);
    expect(product.get("name")).toBe("Engram Student");
    expect(product.get("metadata[tier]")).toBe("student");

    const [, priceInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    const price = new URLSearchParams(priceInit.body as string);
    expect(price.get("product")).toBe("prod_new");
    expect(price.get("unit_amount")).toBe("300");
    expect(price.get("currency")).toBe("usd");
    expect(price.get("recurring[interval]")).toBe("month");
    expect(price.get("lookup_key")).toBe("student_monthly");
    expect(price.get("metadata[tier]")).toBe("student");
  });

  it("surfaces a Stripe permissions failure instead of pretending it worked", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: { message: "Permission denied. ... product_write ..." } }, 403),
    );
    const res = await app({ STRIPE_SECRET_KEY: "rk_restricted" }).call();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: "stripe_error",
      message: expect.stringContaining("product_write"),
    });
  });

  it("refuses when Stripe is not configured at all", async () => {
    const res = await app({}).call();
    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
