import { describe, it, expect } from "vitest";
import app from "../index.js";
import {
  verifyPkceS256,
  sha256Base64Url,
  hashApiKey,
  generateApiKeyRaw,
} from "@getengram/shared";
import {
  createOAuthD1,
  createOAuthEnv,
  signSupabaseJwt,
  pkcePair,
} from "./oauth-helpers.js";

const REDIRECT = "https://chatgpt.com/connector/callback";

// API-key auth updates last_used_at via executionCtx.waitUntil; tests must
// supply a mock context (the OAuth-token path doesn't need it).
const MOCK_CTX = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext;

function form(fields: Record<string, string>): Request {
  return new Request("http://mcp.test/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

async function registerClient(env: ReturnType<typeof createOAuthEnv>): Promise<string> {
  const res = await app.fetch(
    new Request("http://mcp.test/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [REDIRECT] }),
    }),
    env,
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** Run register → authorize → approve and return the authorization code. */
async function getAuthCode(
  env: ReturnType<typeof createOAuthEnv>,
  clientId: string,
  challenge: string,
  email = "alice@example.com",
): Promise<string> {
  const approve = await app.fetch(
    new Request("http://mcp.test/oauth/authorize/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        supabase_token: await signSupabaseJwt(email),
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        scope: "engram:read engram:write",
        state: "xyz",
        approved: true,
      }),
    }),
    env,
  );
  expect(approve.status).toBe(200);
  const { redirect } = (await approve.json()) as { redirect: string };
  const code = new URL(redirect).searchParams.get("code");
  expect(code).toBeTruthy();
  return code as string;
}

describe("OAuth discovery", () => {
  const env = createOAuthEnv(createOAuthD1());

  it("serves protected-resource metadata", async () => {
    const res = await app.fetch(
      new Request("http://mcp.test/.well-known/oauth-protected-resource"),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toBe("http://mcp.test/mcp");
    expect(body.authorization_servers).toEqual(["http://mcp.test"]);
  });

  it("serves authorization-server metadata with S256 + DCR", async () => {
    const res = await app.fetch(
      new Request("http://mcp.test/.well-known/oauth-authorization-server"),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.issuer).toBe("http://mcp.test");
    expect(body.token_endpoint).toBe("http://mcp.test/oauth/token");
    expect(body.registration_endpoint).toBe("http://mcp.test/oauth/register");
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.grant_types_supported).toContain("refresh_token");
  });

  it("serves the OpenAI App Directory domain-verification token", async () => {
    const res = await app.fetch(
      new Request("http://mcp.test/.well-known/openai-apps-challenge"),
      env,
    );
    expect(res.status).toBe(200);
    expect((await res.text()).trim()).toBe("wcJv6LrYXHjM7WuahvvnVsS-MHiXsf198fF43dpFkB8");
  });

  it("challenges unauthenticated /mcp with resource_metadata", async () => {
    const res = await app.fetch(
      new Request("http://mcp.test/mcp", { method: "POST" }),
      env,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(
      'Bearer resource_metadata="http://mcp.test/.well-known/oauth-protected-resource"',
    );
  });
});

describe("PKCE", () => {
  it("verifies a matching S256 verifier and rejects a mismatch", async () => {
    const { verifier, challenge } = await pkcePair();
    expect(await sha256Base64Url(verifier)).toBe(challenge);
    expect(await verifyPkceS256(verifier, challenge)).toBe(true);
    expect(await verifyPkceS256("wrong-verifier", challenge)).toBe(false);
  });
});

describe("Dynamic Client Registration", () => {
  it("registers a public client and returns a client_id", async () => {
    const env = createOAuthEnv(createOAuthD1());
    const clientId = await registerClient(env);
    expect(clientId).toMatch(/^client_/);
  });

  it("rejects registration without redirect_uris", async () => {
    const env = createOAuthEnv(createOAuthD1());
    const res = await app.fetch(
      new Request("http://mcp.test/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "Bad" }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("rejects a non-https / non-loopback redirect_uri", async () => {
    const env = createOAuthEnv(createOAuthD1());
    const res = await app.fetch(
      new Request("http://mcp.test/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://evil.example.com/cb"] }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });
});

describe("Authorization endpoint", () => {
  it("redirects a valid request to the consent page", async () => {
    const env = createOAuthEnv(createOAuthD1());
    const clientId = await registerClient(env);
    const { challenge } = await pkcePair();
    const url = new URL("http://mcp.test/oauth/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", REDIRECT);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", "xyz");

    const res = await app.fetch(new Request(url, { redirect: "manual" }), env);
    expect(res.status).toBe(302);
    const loc = res.headers.get("Location")!;
    expect(loc.startsWith("https://getengram.app/oauth/consent")).toBe(true);
    expect(new URL(loc).searchParams.get("code_challenge")).toBe(challenge);
  });

  it("rejects an unregistered redirect_uri without redirecting", async () => {
    const env = createOAuthEnv(createOAuthD1());
    const clientId = await registerClient(env);
    const url = new URL("http://mcp.test/oauth/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", "https://attacker.example.com/cb");
    url.searchParams.set("code_challenge", "abc");

    const res = await app.fetch(new Request(url), env);
    expect(res.status).toBe(400);
  });

  it("redirects with error when PKCE is missing", async () => {
    const env = createOAuthEnv(createOAuthD1());
    const clientId = await registerClient(env);
    const url = new URL("http://mcp.test/oauth/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", REDIRECT);

    const res = await app.fetch(new Request(url, { redirect: "manual" }), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")!).toContain("error=invalid_request");
  });
});

describe("Token endpoint — authorization_code grant", () => {
  it("exchanges a code (with PKCE) for access + refresh tokens", async () => {
    const env = createOAuthEnv(createOAuthD1());
    const clientId = await registerClient(env);
    const { verifier, challenge } = await pkcePair();
    const code = await getAuthCode(env, clientId, challenge);

    const res = await app.fetch(
      form({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const tok = (await res.json()) as { access_token: string; refresh_token: string; token_type: string };
    expect(tok.token_type).toBe("Bearer");
    expect(tok.access_token).toMatch(/^engram_at_/);
    expect(tok.refresh_token).toMatch(/^engram_rt_/);
  });

  it("rejects a wrong PKCE verifier with invalid_grant", async () => {
    const env = createOAuthEnv(createOAuthD1());
    const clientId = await registerClient(env);
    const { challenge } = await pkcePair();
    const code = await getAuthCode(env, clientId, challenge);

    const res = await app.fetch(
      form({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        redirect_uri: REDIRECT,
        code_verifier: "not-the-real-verifier",
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("rejects code replay (single-use)", async () => {
    const env = createOAuthEnv(createOAuthD1());
    const clientId = await registerClient(env);
    const { verifier, challenge } = await pkcePair();
    const code = await getAuthCode(env, clientId, challenge);
    const fields = {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    };
    expect((await app.fetch(form(fields), env)).status).toBe(200);
    const replay = await app.fetch(form(fields), env);
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe("invalid_grant");
  });
});

describe("Token endpoint — refresh_token grant", () => {
  it("rotates the refresh token and detects reuse", async () => {
    const env = createOAuthEnv(createOAuthD1());
    const clientId = await registerClient(env);
    const { verifier, challenge } = await pkcePair();
    const code = await getAuthCode(env, clientId, challenge);

    const first = (await (
      await app.fetch(
        form({
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          redirect_uri: REDIRECT,
          code_verifier: verifier,
        }),
        env,
      )
    ).json()) as { refresh_token: string };

    // Use the refresh token — should succeed and rotate.
    const refreshed = await app.fetch(
      form({ grant_type: "refresh_token", client_id: clientId, refresh_token: first.refresh_token }),
      env,
    );
    expect(refreshed.status).toBe(200);
    const second = (await refreshed.json()) as { refresh_token: string };
    expect(second.refresh_token).not.toBe(first.refresh_token);

    // Reuse the now-rotated token — reuse detection kicks in.
    const reuse = await app.fetch(
      form({ grant_type: "refresh_token", client_id: clientId, refresh_token: first.refresh_token }),
      env,
    );
    expect(reuse.status).toBe(400);
    expect(((await reuse.json()) as { error_description: string }).error_description).toMatch(/reuse/i);
  });
});

describe("Access token authenticates the MCP endpoint", () => {
  it("accepts a valid access token and rejects a bogus one", async () => {
    const env = createOAuthEnv(createOAuthD1());
    const clientId = await registerClient(env);
    const { verifier, challenge } = await pkcePair();
    const code = await getAuthCode(env, clientId, challenge);
    const tok = (await (
      await app.fetch(
        form({
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          redirect_uri: REDIRECT,
          code_verifier: verifier,
        }),
        env,
      )
    ).json()) as { access_token: string };

    // Valid token: auth middleware passes (not a 401).
    const ok = await app.fetch(
      new Request("http://mcp.test/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tok.access_token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
      env,
    );
    expect(ok.status).not.toBe(401);

    // Bogus access token: 401 with the resource-metadata challenge.
    const bad = await app.fetch(
      new Request("http://mcp.test/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer engram_at_totally-made-up" },
      }),
      env,
    );
    expect(bad.status).toBe(401);
    expect(bad.headers.get("WWW-Authenticate")).toContain("resource_metadata");
  });
});

describe("Connected apps management (/api/oauth/connections)", () => {
  // Seed an org + API key, then connect an app (OAuth) to the same org so the
  // API-key-authenticated dashboard can list and revoke it.
  async function setup() {
    const db = createOAuthD1();
    const env = createOAuthEnv(db);
    const { raw: apiKey, prefix } = generateApiKeyRaw();
    const email = "apps@example.com";

    await db.prepare("INSERT INTO organizations (id, name, email, tier) VALUES (?, ?, ?, ?)")
      .bind("org_ca", "Apps Org", email, "free").run();
    await db.prepare("INSERT INTO api_keys (id, organization_id, key_hash, key_prefix, name, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind("key_ca", "org_ca", await hashApiKey(apiKey), prefix, "Default", "2999-01-01 00:00:00").run();

    // Connect an app via the full OAuth flow (same email → same org).
    const clientId = await registerClient(env);
    const { verifier, challenge } = await pkcePair();
    const code = await getAuthCode(env, clientId, challenge, email);
    const tok = (await (await app.fetch(
      form({ grant_type: "authorization_code", client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: verifier }),
      env,
    )).json()) as { access_token: string };

    return { env, apiKey, clientId, accessToken: tok.access_token };
  }

  const listReq = (apiKey: string) =>
    new Request("http://mcp.test/api/oauth/connections", { headers: { Authorization: `Bearer ${apiKey}` } });

  it("lists a connected app for the org", async () => {
    const { env, apiKey, clientId } = await setup();
    const res = await app.fetch(listReq(apiKey), env, MOCK_CTX);
    expect(res.status).toBe(200);
    const { connections } = (await res.json()) as { connections: Array<{ client_id: string; client_name: string }> };
    expect(connections).toHaveLength(1);
    expect(connections[0].client_id).toBe(clientId);
    expect(connections[0].client_name).toBe("ChatGPT");
  });

  it("revokes a connection and drops it from the list", async () => {
    const { env, apiKey, clientId } = await setup();
    const del = await app.fetch(
      new Request(`http://mcp.test/api/oauth/connections/${clientId}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${apiKey}` },
      }),
      env,
      MOCK_CTX,
    );
    expect(del.status).toBe(200);
    expect(((await del.json()) as { revoked: boolean }).revoked).toBe(true);

    const after = (await (await app.fetch(listReq(apiKey), env, MOCK_CTX)).json()) as { connections: unknown[] };
    expect(after.connections).toHaveLength(0);
  });

  it("revoking invalidates the app's access token on /mcp", async () => {
    const { env, apiKey, clientId, accessToken } = await setup();
    // Token works before revoke.
    const before = await app.fetch(
      new Request("http://mcp.test/mcp", { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } }),
      env,
    );
    expect(before.status).not.toBe(401);

    await app.fetch(
      new Request(`http://mcp.test/api/oauth/connections/${clientId}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${apiKey}` },
      }),
      env,
      MOCK_CTX,
    );

    // Access token deleted → 401.
    const after = await app.fetch(
      new Request("http://mcp.test/mcp", { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } }),
      env,
    );
    expect(after.status).toBe(401);
  });

  it("requires authentication", async () => {
    const { env } = await setup();
    const res = await app.fetch(new Request("http://mcp.test/api/oauth/connections"), env);
    expect(res.status).toBe(401);
  });
});

describe("Published (OAuth) toolset is memory-only", () => {
  async function listTools(env: ReturnType<typeof createOAuthEnv>, token: string) {
    const res = await app.fetch(
      new Request("http://mcp.test/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      env,
      MOCK_CTX,
    );
    return res.text();
  }

  it("OAuth clients get the 6 memory tools and NOT vault/subscription", async () => {
    const env = createOAuthEnv(createOAuthD1());
    const clientId = await registerClient(env);
    const { verifier, challenge } = await pkcePair();
    const code = await getAuthCode(env, clientId, challenge);
    const tok = (await (await app.fetch(
      form({ grant_type: "authorization_code", client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: verifier }),
      env,
    )).json()) as { access_token: string };

    const text = await listTools(env, tok.access_token);
    for (const name of ["create_conversation", "append_messages", "search", "get_conversation", "list_conversations", "delete_conversation"]) {
      expect(text, name).toContain(name);
    }
    for (const name of ["vault_set", "vault_get", "vault_list", "vault_delete", "resolve_vault", "manage_subscription"]) {
      expect(text, name).not.toContain(name);
    }
  });

  it("API-key clients keep the full toolset incl. vault", async () => {
    const db = createOAuthD1();
    const env = createOAuthEnv(db);
    const { raw: apiKey, prefix } = generateApiKeyRaw();
    await db.prepare("INSERT INTO organizations (id, name, tier) VALUES (?, ?, ?)").bind("org_full", "Full", "free").run();
    await db.prepare("INSERT INTO api_keys (id, organization_id, key_hash, key_prefix, name, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind("key_full", "org_full", await hashApiKey(apiKey), prefix, "Default", "2999-01-01 00:00:00").run();

    const text = await listTools(env, apiKey);
    expect(text).toContain("vault_set");
    expect(text).toContain("manage_subscription");
  });
});

describe("Tool output schemas (structuredContent validates at runtime)", () => {
  it("create_conversation returns validated structuredContent via a real tools/call", async () => {
    const env = createOAuthEnv(createOAuthD1());
    const clientId = await registerClient(env);
    const { verifier, challenge } = await pkcePair();
    const code = await getAuthCode(env, clientId, challenge);
    const tok = (await (await app.fetch(
      form({ grant_type: "authorization_code", client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: verifier }),
      env,
    )).json()) as { access_token: string };

    // tools/call goes through the real McpServer, which validates the returned
    // structuredContent against the tool's outputSchema. A schema mismatch
    // would surface as a JSON-RPC error here.
    const res = await app.fetch(
      new Request("http://mcp.test/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tok.access_token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "create_conversation", arguments: { title: "Schema test" } },
        }),
      }),
      env,
      MOCK_CTX,
    );
    const text = await res.text();
    expect(res.status).not.toBe(401);
    expect(text).toContain("structuredContent");
    expect(text).toContain("conversation_id");
    // No JSON-RPC error object (e.g. a validation failure).
    expect(text).not.toMatch(/"error"\s*:\s*\{/);
  });
});
