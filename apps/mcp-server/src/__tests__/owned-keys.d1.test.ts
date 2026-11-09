import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { getOwnedKeyHashes, MAX_OWNED_KEY_HASHES } from "@getengram/db";
import { account } from "../routes/account.js";
import { applyAllMigrations } from "./miniflare.js";
import type { Env, AuthContext } from "../types.js";

/**
 * engram#594, against real SQLite. The CLI daemon sends a queued capture only
 * with a key of the account it was captured for. When the signed-in key
 * changes, it asks with the new key which earlier keys were this account's
 * (POST /api/account/owned-keys). The earlier key is usually revoked by then,
 * so the answer has to come from the key table, revoked rows included, and
 * it must never claim another account's key, including another seat's in
 * the same organization.
 */

type HonoEnv = { Bindings: Env; Variables: { auth: AuthContext } };

const hash = (label: string) => createHash("sha256").update(`engram_sk_live_${label}`).digest("hex");

const OWNER_ACTIVE = hash("owner-active");
const OWNER_REVOKED = hash("owner-revoked");
const OWNER_EXPIRED = hash("owner-expired");
const MEMBER_ACTIVE = hash("member-active");
const MEMBER_REVOKED = hash("member-revoked");
const OTHER_MEMBER = hash("other-member");
const OTHER_ORG = hash("other-org");
const UNKNOWN = hash("never-minted");
const ALL = [
  OWNER_ACTIVE,
  OWNER_REVOKED,
  OWNER_EXPIRED,
  MEMBER_ACTIVE,
  MEMBER_REVOKED,
  OTHER_MEMBER,
  OTHER_ORG,
  UNKNOWN,
];

describe("owned key hashes (engram#594), against real SQLite", () => {
  let mf: Miniflare;
  let db: D1Database;

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "owned-keys" },
    });
    db = await mf.getD1Database("DB");
    await applyAllMigrations(db);

    for (const id of ["org_team", "org_other"]) {
      await db.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)").bind(id, id).run();
    }
    for (const [id, email] of [
      ["seat_member", "member@example.test"],
      ["seat_colleague", "colleague@example.test"],
    ]) {
      await db
        .prepare("INSERT INTO seats (id, organization_id, email) VALUES (?, 'org_team', ?)")
        .bind(id, email)
        .run();
    }
    const key = async (
      id: string,
      org: string,
      keyHash: string,
      seat: string | null,
      extra: "revoked" | "expired" | null = null,
    ) => {
      await db
        .prepare(
          `INSERT INTO api_keys (id, organization_id, key_hash, key_prefix, seat_id, revoked_at, expires_at)
           VALUES (?, ?, ?, 'engram_sk_live_', ?,
                   CASE WHEN ? = 'revoked' THEN datetime('now', '-1 day') END,
                   CASE WHEN ? = 'expired' THEN datetime('now', '-1 day') END)`,
        )
        .bind(id, org, keyHash, seat, extra, extra)
        .run();
    };
    await key("k1", "org_team", OWNER_ACTIVE, null);
    await key("k2", "org_team", OWNER_REVOKED, null, "revoked");
    await key("k3", "org_team", OWNER_EXPIRED, null, "expired");
    await key("k4", "org_team", MEMBER_ACTIVE, "seat_member");
    await key("k5", "org_team", MEMBER_REVOKED, "seat_member", "revoked");
    await key("k6", "org_team", OTHER_MEMBER, "seat_colleague");
    await key("k7", "org_other", OTHER_ORG, null);
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  describe("getOwnedKeyHashes", () => {
    it("claims the owner's keys, revoked and expired included, and nothing else", async () => {
      const owned = await getOwnedKeyHashes(db, "org_team", null, ALL);
      expect(owned.sort()).toEqual([OWNER_ACTIVE, OWNER_REVOKED, OWNER_EXPIRED].sort());
    });

    it("claims only a member's own seat, not the owner's or a colleague's", async () => {
      const owned = await getOwnedKeyHashes(db, "org_team", "seat_member", ALL);
      expect(owned.sort()).toEqual([MEMBER_ACTIVE, MEMBER_REVOKED].sort());
    });

    it("claims nothing for another organization", async () => {
      expect(await getOwnedKeyHashes(db, "org_other", null, [OWNER_ACTIVE, MEMBER_ACTIVE])).toEqual([]);
      expect(await getOwnedKeyHashes(db, "org_other", null, [OTHER_ORG])).toEqual([OTHER_ORG]);
    });

    it(`takes ${MAX_OWNED_KEY_HASHES} hashes in one query, and refuses more`, async () => {
      const many = Array.from({ length: MAX_OWNED_KEY_HASHES - 1 }, (_, i) => hash(`filler-${i}`));
      expect(await getOwnedKeyHashes(db, "org_team", null, [...many, OWNER_REVOKED])).toEqual([OWNER_REVOKED]);
      await expect(getOwnedKeyHashes(db, "org_team", null, [...many, OWNER_REVOKED, UNKNOWN])).rejects.toThrow(
        /at most/,
      );
      expect(await getOwnedKeyHashes(db, "org_team", null, [])).toEqual([]);
    });
  });

  describe("POST /api/account/owned-keys", () => {
    const app = (auth: Partial<AuthContext>) => {
      const a = new Hono<HonoEnv>();
      a.use("*", async (c, next) => {
        c.set("auth", {
          organizationId: "org_team",
          apiKeyId: "k1",
          scopes: ["read"],
          tier: "pro",
          ...auth,
        } as AuthContext);
        await next();
      });
      a.route("/api/account", account);
      return a;
    };
    const ask = (auth: Partial<AuthContext>, body: unknown) =>
      app(auth).request(
        "/api/account/owned-keys",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: typeof body === "string" ? body : JSON.stringify(body),
        },
        { DB: db } as unknown as Env,
      );

    it("answers with the caller's own keys, for a read-only key too", async () => {
      const res = await ask({ seatId: null }, { key_hashes: ALL });
      expect(res.status).toBe(200);
      const { owned } = (await res.json()) as { owned: string[] };
      expect(owned.sort()).toEqual([OWNER_ACTIVE, OWNER_REVOKED, OWNER_EXPIRED].sort());
    });

    it("scopes a member key to its seat", async () => {
      const res = await ask({ apiKeyId: "k4", seatId: "seat_member" }, { key_hashes: ALL });
      const { owned } = (await res.json()) as { owned: string[] };
      expect(owned.sort()).toEqual([MEMBER_ACTIVE, MEMBER_REVOKED].sort());
    });

    it("answers a repeated hash once", async () => {
      const res = await ask({}, { key_hashes: [OWNER_REVOKED, OWNER_REVOKED] });
      expect(await res.json()).toEqual({ owned: [OWNER_REVOKED] });
    });

    it("refuses a connected app", async () => {
      const res = await ask({ apiKeyId: "oauth:client_x", seatId: null }, { key_hashes: [OWNER_ACTIVE] });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "forbidden" });
    });

    it.each([
      ["no body", "not json"],
      ["no key_hashes", {}],
      ["an empty list", { key_hashes: [] }],
      ["too many", { key_hashes: Array.from({ length: MAX_OWNED_KEY_HASHES + 1 }, (_, i) => hash(`x${i}`)) }],
      ["upper-case hex", { key_hashes: [OWNER_ACTIVE.toUpperCase()] }],
      ["a short hash", { key_hashes: [OWNER_ACTIVE.slice(1)] }],
      ["a raw key", { key_hashes: ["engram_sk_live_owner-active"] }],
      ["a number", { key_hashes: [42] }],
      ["a string, not a list", { key_hashes: OWNER_ACTIVE }],
    ])("refuses %s", async (_label, body) => {
      const res = await ask({}, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_request" });
    });
  });
});
