import { describe, it, expect } from "vitest";
import app from "../index.js";
import { createOAuthD1, createOAuthEnv, signSupabaseJwt, pkcePair } from "./oauth-helpers.js";

/**
 * The connector consent path (/oauth/authorize/approve) used to bind whichever
 * Supabase user arrived first with a matching email string — no gate at all,
 * while the website had one since #476. Found by the adversarial review of
 * migration 0040: with the identity pin, an ungated OAuth bind would have
 * become a permanent bypass of the gate on every other surface.
 *
 * Driven through the real router against the OAuth test D1 fake so the
 * assertions are on what the endpoint actually does, not on SQL shapes.
 */

const REDIRECT = "https://chatgpt.com/connector/callback";
const EMAIL = "owner@example.com";
const MOCK_CTX = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;

async function setup(opts: { messages: number; knownSub?: string }) {
  const db = createOAuthD1();
  const env = createOAuthEnv(db);
  const reg = await app.fetch(
    new Request("http://mcp.test/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [REDIRECT] }),
    }),
    env,
    MOCK_CTX,
  );
  const { client_id } = (await reg.json()) as { client_id: string };
  await db
    .prepare("INSERT INTO organizations (id, name, email, messages_stored_total) VALUES (?, ?, ?, ?)")
    .bind("org_victim", "owner", EMAIL, opts.messages)
    .run();
  if (opts.knownSub) {
    await db
      .prepare("INSERT INTO org_identities (organization_id, sub, email, source) VALUES (?, ?, ?, ?)")
      .bind("org_victim", opts.knownSub, EMAIL, "oauth")
      .run();
  }
  const { challenge } = await pkcePair();
  const approve = () =>
    app.fetch(
      new Request("http://mcp.test/oauth/authorize/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supabase_token: undefined, // filled per call
          client_id,
          redirect_uri: REDIRECT,
          code_challenge: challenge,
          state: "s",
          approved: true,
        }),
      }),
      env,
      MOCK_CTX,
    );
  return { db, env, client_id, challenge, approve };
}

async function approveAs(env: ReturnType<typeof createOAuthEnv>, client_id: string, challenge: string, email: string) {
  return app.fetch(
    new Request("http://mcp.test/oauth/authorize/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        supabase_token: await signSupabaseJwt(email), // sub is always "user-1" in the helper
        client_id,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        state: "s",
        approved: true,
      }),
    }),
    env,
    MOCK_CTX,
  );
}

const rows = (db: D1Database, t: string) =>
  ((db as unknown as { _tables: Record<string, unknown[]> })._tables[t] ?? []) as Record<string, unknown>[];

describe("/oauth/authorize/approve on an existing org that holds data", () => {
  it("refuses a sub the org has never seen: no code, no identity, claim_required for the consent page", async () => {
    const { db, env, client_id, challenge } = await setup({ messages: 42 });
    const res = await approveAs(env, client_id, challenge, EMAIL);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; error_description: string; claim: unknown };
    expect(body.error).toBe("claim_required");
    expect(body.error_description).toMatch(/already exists for owner@example\.com/);
    expect(body.claim).toBeTruthy();
    expect(rows(db, "oauth_authorization_codes")).toHaveLength(0);
    expect(rows(db, "org_identities")).toHaveLength(0);
  });

  it("lets the org's own user (on org_identities) connect, as before", async () => {
    const { db, env, client_id, challenge } = await setup({ messages: 42, knownSub: "user-1" });
    const res = await approveAs(env, client_id, challenge, EMAIL);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { redirect: string }).redirect).toMatch(/^https:\/\/chatgpt\.com\/connector\/callback\?code=/);
    expect(rows(db, "oauth_authorization_codes")).toHaveLength(1);
  });

  it("binds an unknown sub to an EMPTY org and records the identity (nothing to take over)", async () => {
    const { db, env, client_id, challenge } = await setup({ messages: 0 });
    const res = await approveAs(env, client_id, challenge, EMAIL);
    expect(res.status).toBe(200);
    const ids = rows(db, "org_identities");
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatchObject({ organization_id: "org_victim", sub: "user-1", source: "oauth" });
  });

  it("records the identity for a brand-new org before anything else can fail", async () => {
    const db = createOAuthD1();
    const env = createOAuthEnv(db);
    const reg = await app.fetch(
      new Request("http://mcp.test/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [REDIRECT] }),
      }),
      env,
      MOCK_CTX,
    );
    const { client_id } = (await reg.json()) as { client_id: string };
    const { challenge } = await pkcePair();
    const res = await approveAs(env, client_id, challenge, "fresh@example.com");
    expect(res.status).toBe(200);
    const ids = rows(db, "org_identities");
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatchObject({ sub: "user-1", source: "oauth" });
    expect(rows(db, "organizations")).toHaveLength(1);
  });
});
