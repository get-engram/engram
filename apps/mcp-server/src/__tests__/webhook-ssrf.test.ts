import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { webhooks } from "../routes/webhooks.js";
import { fireWebhooks } from "../services/webhooks.js";
import {
  validateWebhookUrl,
  parseIpv6,
  isPublicIpv4,
  isPublicIpv6,
  WEBHOOK_MAX_PER_ORG,
  WEBHOOK_URL_MAX_LENGTH,
} from "../services/webhook-url.js";
import { createMockD1, createMockEnv } from "./helpers.js";
import type { Env, AuthContext } from "../types.js";

/**
 * Webhook destinations (engram#448).
 *
 * A webhook URL is an address a customer hands us that we then connect to
 * from our own egress, signed as us. This pins the policy at both ends:
 * registration refuses anything that is not a public https receiver on the
 * default port, and delivery re-checks the stored row, never follows a
 * redirect, and gives up after a bounded time. It also pins the owner-only
 * floor and the per-org cap that keeps one append from fanning out without
 * limit.
 */

type Vars = { Bindings: Env; Variables: { auth: AuthContext } };

const OWNER: AuthContext = {
  organizationId: "org_test",
  apiKeyId: "key_owner",
  tier: "team",
  scopes: ["read", "write", "search", "delete"],
  seatId: null,
};
const MEMBER: AuthContext = { ...OWNER, apiKeyId: "key_member", seatId: "seat_member" };
const FREE_OWNER: AuthContext = { ...OWNER, tier: "free" };

function appAs(auth: AuthContext) {
  const a = new Hono<Vars>();
  a.use("*", async (c, next) => {
    c.set("auth", auth);
    await next();
  });
  a.route("/api/webhooks", webhooks);
  return a;
}

function world() {
  const db = createMockD1();
  const env = createMockEnv(db) as unknown as Env;
  return { db, env };
}

const post = (body: unknown) => ({
  method: "POST",
  body: typeof body === "string" ? body : JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

const GOOD = { url: "https://hooks.example.com/engram", events: ["messages.appended"] };

/** Wrap the mock so every bound statement is recorded with its SQL and bindings. */
function recorded(db: D1Database) {
  const calls: { sql: string; bindings: unknown[] }[] = [];
  const real = db.prepare.bind(db);
  (db as unknown as { prepare: (sql: string) => D1PreparedStatement }).prepare = (sql: string) => {
    const stmt = real(sql);
    const bind = stmt.bind.bind(stmt);
    stmt.bind = (...args: unknown[]) => {
      calls.push({ sql, bindings: args });
      return bind(...args);
    };
    return stmt;
  };
  return calls;
}

describe("validateWebhookUrl", () => {
  const refused: Array<[string, unknown]> = [
    ["a missing url", undefined],
    ["a non-string", 42],
    ["an empty string", ""],
    ["a relative path", "/hooks"],
    ["garbage", "not a url"],
    ["http", "http://hooks.example.com/engram"],
    ["ftp", "ftp://hooks.example.com/engram"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["embedded credentials", "https://user:pw@hooks.example.com/engram"],
    ["an embedded username", "https://user@hooks.example.com/engram"],
    ["a non-default port", "https://hooks.example.com:8443/engram"],
    ["the redis port", "https://hooks.example.com:6379/"],
    ["loopback", "https://127.0.0.1/"],
    ["loopback, short form", "https://127.1/"],
    ["loopback, decimal", "https://2130706433/"],
    ["loopback, hex", "https://0x7f000001/"],
    ["loopback, octal", "https://0177.0.0.1/"],
    ["this-network", "https://0.0.0.0/"],
    ["RFC 1918 10/8", "https://10.0.0.1/"],
    ["RFC 1918 172.16/12", "https://172.31.255.254/"],
    ["RFC 1918 192.168/16", "https://192.168.1.1/"],
    ["the cloud metadata address", "https://169.254.169.254/latest/meta-data/"],
    ["CGNAT", "https://100.64.0.1/"],
    ["the benchmarking block", "https://198.18.0.1/"],
    ["TEST-NET", "https://192.0.2.1/"],
    ["multicast", "https://224.0.0.1/"],
    ["broadcast", "https://255.255.255.255/"],
    ["IPv6 loopback", "https://[::1]/"],
    ["IPv6 unspecified", "https://[::]/"],
    ["IPv4-mapped loopback", "https://[::ffff:127.0.0.1]/"],
    ["IPv4-mapped private, hex form", "https://[::ffff:a00:1]/"],
    ["IPv4-compatible", "https://[::a00:1]/"],
    ["NAT64", "https://[64:ff9b::a00:1]/"],
    ["6to4 of loopback", "https://[2002:7f00:1::1]/"],
    ["Teredo", "https://[2001::1]/"],
    ["IPv6 documentation", "https://[2001:db8::1]/"],
    ["ULA", "https://[fd12:3456:789a::1]/"],
    ["IPv6 link-local", "https://[fe80::1]/"],
    ["IPv6 multicast", "https://[ff02::1]/"],
    ["localhost", "https://localhost/"],
    ["localhost with a trailing dot", "https://localhost./"],
    ["a localhost subdomain", "https://app.localhost/"],
    ["a single label", "https://intranet/"],
    ["the metadata hostname", "https://metadata/"],
    ["GCE metadata", "https://metadata.google.internal/computeMetadata/v1/"],
    ["mDNS", "https://printer.local/"],
    [".internal", "https://vault.internal/"],
    ["the kubernetes API", "https://kubernetes.default.svc/"],
    ["home.arpa", "https://router.home.arpa/"],
    ["the .test TLD", "https://hooks.example.test/"],
    ["the .example TLD", "https://hooks.example/"],
    [".onion", "https://abc.onion/"],
    ["an underscore label", "https://my_hooks.example.com/"],
    ["an over-long url", "https://hooks.example.com/" + "a".repeat(WEBHOOK_URL_MAX_LENGTH)],
  ];
  it.each(refused)("refuses %s", (_label, raw) => {
    const v = validateWebhookUrl(raw);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/\S/);
  });

  const accepted: Array<[string, string, string]> = [
    ["a public hostname", "https://hooks.example.com/engram", "https://hooks.example.com/engram"],
    [
      "mixed case, explicit :443 and dot segments, canonicalised",
      "https://Hooks.Example.COM:443/a/../engram?x=1",
      "https://hooks.example.com/engram?x=1",
    ],
    ["a public IPv4 literal", "https://8.8.8.8/hook", "https://8.8.8.8/hook"],
    ["a public IPv6 literal", "https://[2606:4700::6810:84e5]/hook", "https://[2606:4700::6810:84e5]/hook"],
    ["an IDN, punycoded", "https://hooks.exämple.com/", "https://hooks.xn--exmple-cua.com/"],
  ];
  it.each(accepted)("accepts %s", (_label, raw, canonical) => {
    expect(validateWebhookUrl(raw)).toEqual({ ok: true, url: canonical });
  });

  it("classifies IPv4 ranges per the special-purpose registry", () => {
    expect(isPublicIpv4(93, 184, 216, 34)).toBe(true);
    expect(isPublicIpv4(100, 63, 255, 255)).toBe(true); // just below CGNAT
    expect(isPublicIpv4(100, 128, 0, 0)).toBe(true); // just above CGNAT
    expect(isPublicIpv4(172, 15, 0, 1)).toBe(true);
    expect(isPublicIpv4(172, 32, 0, 1)).toBe(true);
    expect(isPublicIpv4(192, 0, 1, 1)).toBe(true); // between 192.0.0/24 and 192.0.2/24
    expect(isPublicIpv4(198, 20, 0, 1)).toBe(true);
    expect(isPublicIpv4(223, 255, 255, 255)).toBe(true);
    expect(isPublicIpv4(256, 0, 0, 1)).toBe(false);
  });

  it("parses IPv6 literals strictly", () => {
    expect(parseIpv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIpv6("::ffff:10.0.0.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0a00, 0x0001]);
    expect(parseIpv6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseIpv6("1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(parseIpv6("1:2:3:4:5:6:7:8::")).toBeNull(); // :: must stand for at least one group
    expect(parseIpv6("1::2::3")).toBeNull();
    expect(parseIpv6("12345::")).toBeNull();
    expect(parseIpv6("fe80::1%eth0")).toBeNull();
    expect(parseIpv6("::ffff:10.0.0.256")).toBeNull();
    expect(isPublicIpv6(parseIpv6("2606:4700::6810:84e5")!)).toBe(true);
    expect(isPublicIpv6(parseIpv6("2002:808:808::")!)).toBe(true); // 6to4 of 8.8.8.8
    expect(isPublicIpv6(parseIpv6("::ffff:8.8.8.8")!)).toBe(true); // mapped public
    expect(isPublicIpv6(parseIpv6("::ffff:0:8.8.8.8")!)).toBe(false); // IPv4-translated, not mapped
    expect(isPublicIpv6(parseIpv6("3fff::1")!)).toBe(true); // top of 2000::/3
    expect(isPublicIpv6(parseIpv6("4000::1")!)).toBe(false); // outside global unicast
  });
});

describe("/api/webhooks", () => {
  it("is owner-only: a member seat key gets 403 on every verb", async () => {
    const { env } = world();
    const app = appAs(MEMBER);
    for (const init of [{ method: "GET" }, post(GOOD), { method: "DELETE" }]) {
      const path = init.method === "DELETE" ? "/api/webhooks/whk_x" : "/api/webhooks";
      const res = await app.request(path, init, env);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "forbidden" });
    }
  });

  it("stays gated to Team and above", async () => {
    const { env } = world();
    const res = await appAs(FREE_OWNER).request("/api/webhooks", post(GOOD), env);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "feature_not_available", tier: "free" });
  });

  it("rejects a body that is not a JSON object", async () => {
    const { env } = world();
    const app = appAs(OWNER);
    for (const body of ["not json", "null", '"https://hooks.example.com/"']) {
      const res = await app.request("/api/webhooks", post(body), env);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_body" });
    }
  });

  it.each([
    "http://hooks.example.com/engram",
    "https://127.0.0.1/",
    "https://[::1]/",
    "https://10.0.0.1/",
    "https://localhost/",
    "https://user:pw@hooks.example.com/",
    "https://2130706433/",
    "https://hooks.example.com:6379/",
    "https://169.254.169.254/latest/meta-data/",
    "https://metadata.google.internal/",
  ])("refuses to register %s and stores nothing", async (url) => {
    const { env } = world();
    const app = appAs(OWNER);
    const res = await app.request("/api/webhooks", post({ ...GOOD, url }), env);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_url" });
    const list = await app.request("/api/webhooks", { method: "GET" }, env);
    expect(await list.json()).toEqual({ webhooks: [] });
  });

  it("requires at least one known event and ignores junk in the list", async () => {
    const { env } = world();
    const app = appAs(OWNER);
    for (const events of [undefined, "messages.appended", [], ["nope"], [42, null]]) {
      const res = await app.request("/api/webhooks", post({ url: GOOD.url, events }), env);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_events" });
    }
    const res = await app.request(
      "/api/webhooks",
      post({ url: GOOD.url, events: ["nope", 42, "conversation.created", null] }),
      env,
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { events: string[] }).events).toEqual(["conversation.created"]);
  });

  it("registers a public https receiver in canonical form and lists it without the secret", async () => {
    const { env } = world();
    const app = appAs(OWNER);
    const res = await app.request(
      "/api/webhooks",
      post({ url: "https://Hooks.Example.COM:443/a/../engram", events: GOOD.events }),
      env,
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; url: string; events: string[]; secret: string };
    expect(created).toMatchObject({ url: "https://hooks.example.com/engram", events: GOOD.events });
    expect(created.id).toMatch(/^whk_/);
    expect(created.secret).toMatch(/\S/);

    const list = await app.request("/api/webhooks", { method: "GET" }, env);
    const { webhooks: rows } = (await list.json()) as { webhooks: Record<string, unknown>[] };
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: created.id, url: "https://hooks.example.com/engram" });
    expect(rows[0]).not.toHaveProperty("secret");
  });

  it(`caps an organization at ${WEBHOOK_MAX_PER_ORG} endpoints`, async () => {
    const { env } = world();
    const app = appAs(OWNER);
    for (let i = 0; i < WEBHOOK_MAX_PER_ORG; i++) {
      const res = await app.request("/api/webhooks", post({ ...GOOD, url: `${GOOD.url}/${i}` }), env);
      expect(res.status).toBe(201);
    }
    const res = await app.request("/api/webhooks", post(GOOD), env);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "webhook_limit_reached" });

    // Another org is unaffected by this one's cap.
    const other = appAs({ ...OWNER, organizationId: "org_other" });
    expect((await other.request("/api/webhooks", post(GOOD), env)).status).toBe(201);
  });
});

describe("fireWebhooks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function endpoint(db: D1Database, id: string, url: string) {
    await db
      .prepare("INSERT INTO webhook_endpoints (id, organization_id, url, events, secret) VALUES (?, ?, ?, ?, ?)")
      .bind(id, "org_test", url, JSON.stringify(["messages.appended"]), "whsec_test")
      .run();
  }

  function deliveryOf(calls: { sql: string; bindings: unknown[] }[]) {
    const inserted = calls.find((c) => c.sql.includes("INSERT INTO webhook_deliveries"));
    const updated = calls.find((c) => c.sql.includes("UPDATE webhook_deliveries"));
    return { id: inserted?.bindings[0], update: updated?.bindings };
  }

  it("never fetches a stored URL that fails the policy, and logs the delivery as failed", async () => {
    const db = createMockD1();
    const calls = recorded(db);
    // A row written before the policy existed, or edited by hand.
    await endpoint(db, "whk_legacy", "http://10.0.0.1/hook");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await fireWebhooks(db, "org_test", "messages.appended", { conversation_id: "conv_1" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("whk_legacy"));
    const d = deliveryOf(calls);
    expect(d.id).toMatch(/^whd_/);
    expect(d.update).toEqual([0, 0, d.id]);
  });

  it("delivers to a policy-passing endpoint without following redirects and under a timeout", async () => {
    const db = createMockD1();
    const calls = recorded(db);
    await endpoint(db, "whk_ok", "https://hooks.example.com/engram");
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await fireWebhooks(db, "org_test", "messages.appended", { conversation_id: "conv_1" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    const d = deliveryOf(calls);
    expect(url).toBe("https://hooks.example.com/engram");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
    expect(init.headers["X-Engram-Event"]).toBe("messages.appended");
    expect(init.headers["X-Engram-Delivery"]).toBe(d.id);
    expect(init.headers["X-Engram-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(d.update).toEqual([200, 1, d.id]);
  });

  it("records a redirect as a failed delivery instead of following it", async () => {
    const db = createMockD1();
    const calls = recorded(db);
    await endpoint(db, "whk_redirect", "https://hooks.example.com/engram");
    const fetchMock = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "https://10.0.0.1/" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fireWebhooks(db, "org_test", "messages.appended", { conversation_id: "conv_1" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const d = deliveryOf(calls);
    expect(d.update).toEqual([302, 0, d.id]);
  });

  it("records a fetch that throws (timeout, DNS failure) as a failed delivery", async () => {
    const db = createMockD1();
    const calls = recorded(db);
    await endpoint(db, "whk_slow", "https://hooks.example.com/engram");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }),
    );

    await expect(
      fireWebhooks(db, "org_test", "messages.appended", { conversation_id: "conv_1" }),
    ).resolves.toBeUndefined();
    const d = deliveryOf(calls);
    expect(d.update).toEqual([0, 0, d.id]);
  });
});
