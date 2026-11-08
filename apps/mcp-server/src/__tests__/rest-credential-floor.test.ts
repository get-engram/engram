import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import app from "../index.js";
import { memories } from "../routes/memories.js";
import { dataExport } from "../routes/export.js";
import { seats } from "../routes/seats.js";
import { webhooks } from "../routes/webhooks.js";
import { oauthConnections } from "../routes/oauth-connections.js";
import { student } from "../routes/student.js";
import { createMockD1, createMockEnv } from "./helpers.js";
import type { Env, AuthContext } from "../types.js";

/**
 * The credential floor on the REST routes outside /api/v1 (engram#603).
 *
 * - Each memory route asks for the scope its MCP tool and /api/v1 twin ask for.
 * - A connected OAuth app is granted memory, never the account around it, so
 *   it does not read or change members, connections, webhooks or billing status.
 * - An invitation becomes a seat key with every scope, so issuing one needs a
 *   caller that holds every scope (the mintableScopes rule, engram#475).
 *
 * A refusal must have no side effect: no write reaches D1 and no mail is sent.
 * An allowed caller is shown past the gate by the route's own validation
 * answering next (a 400 or 404), so nothing is stored there either.
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
// Every scope, on purpose: a connector is refused for what it is, not for
// what it holds. (Real OAuth tokens never carry `delete`.)
const CONNECTOR: AuthContext = { ...OWNER, apiKeyId: "oauth:client_app" };
const READ_ONLY: AuthContext = { ...OWNER, apiKeyId: "key_ro", scopes: ["read", "search"] };
const WRITE_ONLY: AuthContext = { ...OWNER, apiKeyId: "key_wo", scopes: ["write"] };
const NO_DELETE: AuthContext = { ...OWNER, apiKeyId: "key_nd", scopes: ["read", "write", "search"] };

/** A mock D1 that records every statement prepared against it. */
function world() {
  const db = createMockD1();
  const sql: string[] = [];
  const prepare = db.prepare.bind(db);
  db.prepare = ((query: string) => {
    sql.push(query);
    return prepare(query);
  }) as D1Database["prepare"];
  const env = {
    ...createMockEnv(db),
    APP_URL: "https://app.test",
    ADMIN_SECRET: "admin_test",
  } as unknown as Env;
  return {
    env,
    writes: () => sql.filter((q) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(q)),
  };
}

function as(auth: AuthContext, w: ReturnType<typeof world>) {
  const a = new Hono<Vars>();
  a.use("*", async (c, next) => {
    c.set("auth", auth);
    await next();
  });
  a.route("/api/memories", memories);
  a.route("/api/export", dataExport);
  a.route("/api/seats", seats);
  a.route("/api/webhooks", webhooks);
  a.route("/api/oauth/connections", oauthConnections);
  a.route("/api/student", student);
  return (path: string, init: RequestInit = {}) => a.request(path, init, w.env);
}

const send = (method: string, body?: unknown): RequestInit =>
  body === undefined
    ? { method }
    : { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } };

async function refusedForScope(res: Response, scope: string) {
  expect(res.status).toBe(403);
  expect(await res.json()).toMatchObject({ error: "insufficient_scope", required: scope });
}

async function forbidden(res: Response) {
  expect(res.status).toBe(403);
  expect(await res.json()).toMatchObject({ error: "forbidden" });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/api/memories asks for the scope its MCP tool asks for", () => {
  it("saving needs write: a read-only key is refused before anything is charged or stored", async () => {
    const w = world();
    await refusedForScope(await as(READ_ONLY, w)("/api/memories", send("POST", { text: "remember this" })), "write");
    expect(w.writes()).toEqual([]);
  });

  it("searching needs search: a write-only key is refused before the search is counted", async () => {
    const w = world();
    await refusedForScope(await as(WRITE_ONLY, w)("/api/memories/search?q=anything"), "search");
    expect(w.writes()).toEqual([]);
  });

  it("the owner, and a connector holding the scope, get past the gate", async () => {
    for (const auth of [OWNER, CONNECTOR]) {
      const w = world();
      expect((await as(auth, w)("/api/memories", send("POST", {}))).status).toBe(400);
      expect((await as(auth, w)("/api/memories/search")).status).toBe(400);
    }
    const w = world();
    expect((await as(READ_ONLY, w)("/api/memories/search")).status).toBe(400);
  });
});

describe("/api/export needs read", () => {
  it("refuses a key without read, writing nothing (not even the export audit)", async () => {
    const w = world();
    await refusedForScope(await as(WRITE_ONLY, w)("/api/export"), "read");
    expect(w.writes()).toEqual([]);
  });

  it("still refuses a connected app, and the owner gets past the gate", async () => {
    await forbidden(await as(CONNECTOR, world())("/api/export"));
    expect((await as(READ_ONLY, world())("/api/export?cursor=not-a-cursor")).status).toBe(400);
  });
});

describe("/api/seats", () => {
  it("inviting needs every scope: a key without delete cannot issue a key that has it", async () => {
    const w = world();
    await refusedForScope(
      await as(NO_DELETE, w)("/api/seats", send("POST", { email: "new@example.com" })),
      "delete",
    );
    await refusedForScope(
      await as(READ_ONLY, w)("/api/seats", send("POST", { email: "new@example.com" })),
      "write",
    );
    expect(w.writes()).toEqual([]);
  });

  it("re-sending an invite mints a fresh token, so it needs every scope too", async () => {
    const w = world();
    await refusedForScope(await as(NO_DELETE, w)("/api/seats/seat_x/resend", send("POST")), "delete");
    await forbidden(await as(CONNECTOR, w)("/api/seats/seat_x/resend", send("POST")));
    await forbidden(await as(MEMBER, w)("/api/seats/seat_x/resend", send("POST")));
    expect(w.writes()).toEqual([]);
  });

  it("a connected app or a member cannot invite, even holding every scope", async () => {
    const w = world();
    await forbidden(await as(CONNECTOR, w)("/api/seats", send("POST", { email: "new@example.com" })));
    await forbidden(await as(MEMBER, w)("/api/seats", send("POST", { email: "new@example.com" })));
    expect(w.writes()).toEqual([]);
  });

  it("changing or removing a member needs a first-party key that can write", async () => {
    const w = world();
    await refusedForScope(await as(READ_ONLY, w)("/api/seats/seat_x", send("PATCH", { role: "admin" })), "write");
    await refusedForScope(await as(READ_ONLY, w)("/api/seats/seat_x", send("DELETE")), "write");
    await forbidden(await as(CONNECTOR, w)("/api/seats/seat_x", send("PATCH", { role: "admin" })));
    await forbidden(await as(CONNECTOR, w)("/api/seats/seat_x", send("DELETE")));
    await forbidden(await as(MEMBER, w)("/api/seats/seat_x", send("DELETE")));
    expect(w.writes()).toEqual([]);
  });

  it("a connected app cannot list members; a member and a read-only key still can", async () => {
    await forbidden(await as(CONNECTOR, world())("/api/seats"));
    expect((await as(MEMBER, world())("/api/seats")).status).toBe(200);
    expect((await as(READ_ONLY, world())("/api/seats")).status).toBe(200);
  });

  it("the owner gets past every gate", async () => {
    const w = world();
    const call = as(OWNER, w);
    expect((await call("/api/seats", send("POST", {}))).status).toBe(400);
    expect((await call("/api/seats/seat_x/resend", send("POST"))).status).toBe(404);
    expect((await call("/api/seats/seat_x", send("PATCH", { role: "owner" }))).status).toBe(400);
    expect((await call("/api/seats/seat_x", send("DELETE"))).status).toBe(404);
  });
});

describe("/api/webhooks", () => {
  it("a connected app cannot list or register webhooks, even holding every scope", async () => {
    const w = world();
    await forbidden(await as(CONNECTOR, w)("/api/webhooks"));
    await forbidden(
      await as(CONNECTOR, w)(
        "/api/webhooks",
        send("POST", { url: "https://hooks.example.com/in", events: ["conversation.created"] }),
      ),
    );
    expect(w.writes()).toEqual([]);
  });

  it("a read-only key can list but not change them", async () => {
    const w = world();
    expect((await as(READ_ONLY, w)("/api/webhooks")).status).toBe(200);
    await refusedForScope(
      await as(READ_ONLY, w)(
        "/api/webhooks",
        send("POST", { url: "https://hooks.example.com/in", events: ["conversation.created"] }),
      ),
      "write",
    );
    await refusedForScope(await as(READ_ONLY, w)("/api/webhooks/wh_x", send("DELETE")), "write");
    expect(w.writes()).toEqual([]);
  });

  it("the owner gets past the gate; a member still does not", async () => {
    expect((await as(OWNER, world())("/api/webhooks", send("POST", {}))).status).toBe(400);
    await forbidden(await as(MEMBER, world())("/api/webhooks"));
  });
});

describe("/api/oauth/connections", () => {
  it("a connected app can neither list nor disconnect apps", async () => {
    const w = world();
    await forbidden(await as(CONNECTOR, w)("/api/oauth/connections"));
    await forbidden(await as(CONNECTOR, w)("/api/oauth/connections/client_other", send("DELETE")));
    expect(w.writes()).toEqual([]);
  });

  it("disconnecting is the owner's, with a key that can write", async () => {
    const w = world();
    await forbidden(await as(MEMBER, w)("/api/oauth/connections/client_other", send("DELETE")));
    await refusedForScope(
      await as(READ_ONLY, w)("/api/oauth/connections/client_other", send("DELETE")),
      "write",
    );
    expect(w.writes()).toEqual([]);

    const owner = world();
    const res = await as(OWNER, owner)("/api/oauth/connections/client_other", send("DELETE"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true });
    expect(owner.writes().length).toBeGreaterThan(0);
  });

  it("a member can still see what is connected", async () => {
    expect((await as(MEMBER, world())("/api/oauth/connections")).status).toBe(200);
  });
});

describe("/api/student", () => {
  it("only the owner, first-party and able to write, starts a verification; refusals send nothing", async () => {
    // Resolves without a network call, so a missing guard shows up as a call
    // here rather than as a request leaving the test.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));
    const w = world();
    const body = { email: "someone@university.edu" };
    await forbidden(await as(CONNECTOR, w)("/api/student/verify", send("POST", body)));
    await forbidden(await as(MEMBER, w)("/api/student/verify", send("POST", body)));
    await refusedForScope(await as(READ_ONLY, w)("/api/student/verify", send("POST", body)), "write");
    expect(w.writes()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();

    expect((await as(OWNER, world())("/api/student/verify", send("POST", { email: "nope" }))).status).toBe(400);
  });

  it("a connected app cannot read the org's student status; a member can", async () => {
    await forbidden(await as(CONNECTOR, world())("/api/student/status"));
    expect((await as(MEMBER, world())("/api/student/status")).status).toBe(200);
  });

  it("redeeming a verification link stays public: not behind auth or the connector gate", async () => {
    const db = createMockD1();
    const env = { ...createMockEnv(db), APP_URL: "https://app.test" } as unknown as Env;
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
    const res = await app.fetch(new Request("http://localhost/api/student/confirm", send("POST", {})), env, ctx);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });
});
