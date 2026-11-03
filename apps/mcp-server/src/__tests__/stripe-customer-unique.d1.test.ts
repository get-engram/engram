import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Miniflare } from "miniflare";
import { clearOrganizationStripeCustomer, setOrganizationStripeCustomer } from "@getengram/db";
import { bindStripeCustomer } from "../services/stripe-customer.js";
import { applyMigration } from "./miniflare.js";

/**
 * engram#536: one Stripe customer, one organization. The resolver checks the
 * Stripe-side stamp before a cached id is used; the partial unique index of
 * migration 0045 is the D1-side backstop. The index only exists in real
 * SQLite — the mock D1 cannot refuse a write — so the index, the error it
 * raises, and the binder that turns that error into "conflict" are proven
 * here. The three call sites are covered in billing.test.ts with the refusal
 * stood in for.
 */

// 0001's organizations table, verbatim.
const ORGANIZATIONS_0001 = `CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

describe("one organization per Stripe customer, against real SQLite", () => {
  let mf: Miniflare;
  let db: D1Database;
  let seq = 0;

  async function org(): Promise<string> {
    const id = `org_u${++seq}`;
    await db.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)").bind(id, id).run();
    return id;
  }

  async function customerOf(id: string): Promise<string | null> {
    const row = await db
      .prepare("SELECT stripe_customer_id FROM organizations WHERE id = ?")
      .bind(id)
      .first<{ stripe_customer_id: string | null }>();
    if (!row) throw new Error(`no organization ${id}`);
    return row.stripe_customer_id;
  }

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "stripe-customer-unique-test" },
    });
    db = (await mf.getD1Database("DB")) as unknown as D1Database;
    await db.prepare(ORGANIZATIONS_0001).run();
    // 0003's column and plain index, as production has them.
    await db.prepare("ALTER TABLE organizations ADD COLUMN stripe_customer_id TEXT").run();
    await db
      .prepare(
        "CREATE INDEX IF NOT EXISTS idx_orgs_stripe_customer ON organizations(stripe_customer_id)",
      )
      .run();
    await applyMigration(db, "_organizations_stripe_customer_unique.sql");
  }, 60_000);

  afterAll(async () => {
    await mf.dispose();
  });

  it("refuses a second organization binding the same customer and leaves both rows as they were", async () => {
    const a = await org();
    const b = await org();
    await setOrganizationStripeCustomer(db, a, "cus_shared");
    await expect(setOrganizationStripeCustomer(db, b, "cus_shared")).rejects.toThrow(
      /UNIQUE constraint failed: organizations\.stripe_customer_id/,
    );
    expect(await customerOf(a)).toBe("cus_shared");
    expect(await customerOf(b)).toBeNull();
  });

  it("leaves organizations without a customer unconstrained; re-caching the same customer is a no-op", async () => {
    // NULL is the common state — a non-partial unique index would allow one such row.
    const a = await org();
    const b = await org();
    const c = await org();
    expect([await customerOf(a), await customerOf(b), await customerOf(c)]).toEqual([
      null,
      null,
      null,
    ]);
    await setOrganizationStripeCustomer(db, a, "cus_again");
    // The checkout.session.completed webhook re-caches defensively.
    await setOrganizationStripeCustomer(db, a, "cus_again");
    expect(await customerOf(a)).toBe("cus_again");
  });

  it("lets a customer move once the previous holder released it", async () => {
    const a = await org();
    const b = await org();
    await setOrganizationStripeCustomer(db, a, "cus_moving");
    await clearOrganizationStripeCustomer(db, a, "cus_moving");
    await setOrganizationStripeCustomer(db, b, "cus_moving");
    expect(await customerOf(a)).toBeNull();
    expect(await customerOf(b)).toBe("cus_moving");
  });

  it("applies the migration a second time without error", async () => {
    await expect(
      applyMigration(db, "_organizations_stripe_customer_unique.sql"),
    ).resolves.toBeUndefined();
  });

  it("bindStripeCustomer: bound for the first org; conflict, nothing written, one error line for the second", async () => {
    const a = await org();
    const b = await org();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await bindStripeCustomer(db, a, "cus_bound")).toBe("bound");
      expect(quiet).not.toHaveBeenCalled();
      expect(await bindStripeCustomer(db, b, "cus_bound")).toBe("conflict");
      expect(quiet).toHaveBeenCalledTimes(1);
      const line = String(quiet.mock.calls[0][0]);
      expect(line).toContain(b);
      expect(line).toContain("cus_bound");
    } finally {
      quiet.mockRestore();
    }
    expect(await customerOf(a)).toBe("cus_bound");
    expect(await customerOf(b)).toBeNull();
  });
});
