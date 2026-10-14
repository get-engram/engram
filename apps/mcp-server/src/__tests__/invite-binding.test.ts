import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { invites } from "../routes/invites.js";
import type { Env } from "../types.js";

/**
 * A team invite is addressed to a PERSON, not to whoever holds the link.
 *
 * The accept handler used to take any signed-in account and then overwrite
 * the seat's email with theirs, so a forwarded invite handed the recipient a
 * full-scope key (read,write,search,delete) on the org's shared memory. That
 * matters most for exactly the customer asking for it: a department or
 * research group sharing one memory.
 */
const SECRET = "test-jwt-secret-invite-binding";

async function signJwt(payload: Record<string, unknown>): Promise<string> {
  const enc = new TextEncoder();
  const b64 = (b: ArrayBuffer | Uint8Array) => {
    const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
    let s = "";
    for (const x of bytes) s += String.fromCharCode(x);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const header = b64(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${header}.${body}`));
  return `${header}.${body}.${b64(sig)}`;
}

function stubDb(seatEmail: string | null) {
  const writes: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    prepare: (sql: string) => {
      let args: unknown[] = [];
      const stmt = {
        bind: (...a: unknown[]) => {
          args = a;
          return stmt;
        },
        first: async () => {
          if (/FROM seats WHERE invite_token_hash/i.test(sql) || /FROM seats/i.test(sql)) {
            return {
              id: "seat_1",
              organization_id: "org_lab",
              email: seatEmail,
              role: "member",
              accepted_at: null,
              invited_at: new Date().toISOString(),
            };
          }
          if (/FROM organizations WHERE id/i.test(sql)) {
            return { id: "org_lab", name: "Lab", tier: "team", deleted_at: null };
          }
          return null;
        },
        run: async () => {
          writes.push({ sql, args });
          return { success: true, meta: { changes: 1 } };
        },
        all: async () => ({ results: [] }),
      };
      return stmt;
    },
    batch: async () => [],
  } as unknown as D1Database;
  return { db, writes };
}

function app(db: D1Database) {
  const a = new Hono<{ Bindings: Env }>();
  a.route("/invites", invites);
  return {
    app: a,
    env: { DB: db, SUPABASE_JWT_SECRET: SECRET, SUPABASE_URL: "https://x.supabase.co" } as unknown as Env,
  };
}

async function accept(db: D1Database, asEmail: string) {
  const { app: a, env } = app(db);
  const jwt = await signJwt({
    sub: "u1",
    email: asEmail,
    role: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 600,
  });
  return a.request(
    "/invites/accept",
    {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      body: JSON.stringify({ token: "invite-token" }),
    },
    env,
  );
}

const minted = (w: Array<{ sql: string }>) => w.some((x) => /INSERT INTO api_keys/i.test(x.sql));

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe("accepting a team invite", () => {
  it("lets the invited person in and mints their seat key", async () => {
    const { db, writes } = stubDb("alice@uni.edu");
    const res = await accept(db, "alice@uni.edu");
    expect(res.status).toBe(200);
    expect(minted(writes)).toBe(true);
  });

  it("ignores case and surrounding whitespace on a genuine match", async () => {
    const { db, writes } = stubDb("Alice@Uni.edu");
    const res = await accept(db, "  alice@uni.edu ");
    expect(res.status).toBe(200);
    expect(minted(writes)).toBe(true);
  });

  it("refuses a FORWARDED invite and mints nothing", async () => {
    const { db, writes } = stubDb("alice@uni.edu");
    const res = await accept(db, "mallory@elsewhere.com");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("wrong_account");
    expect(minted(writes), "a forwarded invite must not mint a key").toBe(false);
    // and the attempt is recorded, since it is the signature of a leaked link
    expect(writes.some((w) => /INSERT INTO audit_log/i.test(w.sql))).toBe(true);
  });

  it("refuses when the seat carries no invited address to verify against", async () => {
    const { db, writes } = stubDb(null);
    const res = await accept(db, "anyone@example.com");
    expect(res.status).toBe(403);
    expect(minted(writes)).toBe(false);
  });
});
