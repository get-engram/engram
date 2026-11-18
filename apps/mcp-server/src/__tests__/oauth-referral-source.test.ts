import { describe, it, expect } from "vitest";
import app from "../index.js";
import { CLAUDE_APPS_CALLBACK, oauthReferralSource } from "../oauth/router.js";
import { createOAuthD1, createOAuthEnv, signSupabaseJwt, pkcePair } from "./oauth-helpers.js";

// engram#761: the Claude connector directory listing went live on 2026-11-17.
// A new account created by connecting from the Claude apps used to be
// recorded as plain "claude"; it is now "claude-directory".

describe("oauthReferralSource", () => {
  it("labels the Claude apps' client as claude-directory", () => {
    expect(oauthReferralSource("Claude", [CLAUDE_APPS_CALLBACK])).toBe("claude-directory");
  });

  it("keeps every other client's own name", () => {
    expect(oauthReferralSource("ChatGPT", ["https://chatgpt.com/connector/callback"])).toBe("chatgpt");
    expect(oauthReferralSource("Claude Desktop", [CLAUDE_APPS_CALLBACK])).toBe("claude-desktop");
    expect(oauthReferralSource(null, [CLAUDE_APPS_CALLBACK])).toBe("oauth");
  });

  it("leaves Claude Code on its own label", () => {
    expect(oauthReferralSource("Claude Code (engram)", ["http://localhost:53682/callback"])).toBe(
      "claude-code-(engram)",
    );
    expect(oauthReferralSource("Claude Code (plugin:engram:engram)", ["http://localhost:53682/callback"])).toBe(
      "claude-code-(plugin:engram:engram)",
    );
  });

  it("does not trust the name alone", () => {
    // Anyone can register as "Claude"; without the claude.ai callback it is
    // not the Claude apps.
    expect(oauthReferralSource("Claude", ["https://example.com/cb"])).toBe("claude");
    expect(oauthReferralSource("Claude", ["http://localhost:1234/cb"])).toBe("claude");
    // A second callback means codes could go somewhere other than claude.ai.
    expect(oauthReferralSource("Claude", [CLAUDE_APPS_CALLBACK, "https://example.com/cb"])).toBe("claude");
    expect(oauthReferralSource("Claude", [])).toBe("claude");
    // A look-alike host is not the callback.
    expect(oauthReferralSource("Claude", ["https://claude.ai.example.com/api/mcp/auth_callback"])).toBe("claude");
  });

  it("does not trust the callback alone", () => {
    expect(oauthReferralSource("Connector Tester", [CLAUDE_APPS_CALLBACK])).toBe("connector-tester");
  });
});

describe("signup through OAuth approval records the source (engram#761)", () => {
  type Org = { email: string; referral_source: string | null };

  async function signUp(clientName: string, redirect: string, email: string) {
    const db = createOAuthD1();
    const env = createOAuthEnv(db);
    const reg = await app.fetch(
      new Request("http://mcp.test/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: clientName,
          redirect_uris: [redirect],
          token_endpoint_auth_method: "client_secret_post",
        }),
      }),
      env,
    );
    expect(reg.status).toBe(201);
    const { client_id } = (await reg.json()) as { client_id: string };
    const { challenge } = await pkcePair();
    const approve = await app.fetch(
      new Request("http://mcp.test/oauth/authorize/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supabase_token: await signSupabaseJwt(email),
          client_id,
          redirect_uri: redirect,
          code_challenge: challenge,
          scope: "engram:read engram:write",
          state: "s",
          approved: true,
        }),
      }),
      env,
    );
    expect(approve.status).toBe(200);
    const orgs = (db as unknown as { _tables: Record<string, Org[]> })._tables.organizations ?? [];
    return { db, env, client_id, challenge, orgs };
  }

  it("a new account from the Claude apps is claude-directory", async () => {
    const { orgs } = await signUp("Claude", CLAUDE_APPS_CALLBACK, "new@example.com");
    expect(orgs).toHaveLength(1);
    expect(orgs[0].referral_source).toBe("claude-directory");
  });

  it("a new account from ChatGPT is still chatgpt", async () => {
    const { orgs } = await signUp("ChatGPT", "https://chatgpt.com/connector/callback", "new@example.com");
    expect(orgs).toHaveLength(1);
    expect(orgs[0].referral_source).toBe("chatgpt");
  });

  it("a new account from Claude Code keeps its own label", async () => {
    const { orgs } = await signUp("Claude Code (engram)", "http://localhost:53682/callback", "new@example.com");
    expect(orgs[0].referral_source).toBe("claude-code-(engram)");
  });

  it("an account that already exists keeps the source it signed up with", async () => {
    const db = createOAuthD1();
    const env = createOAuthEnv(db);
    await db
      .prepare("INSERT INTO organizations (id, name, email, referral_source, country) VALUES (?, ?, ?, ?, ?)")
      .bind("org_old", "old", "old@example.com", "chatgpt", null)
      .run();
    const reg = await app.fetch(
      new Request("http://mcp.test/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "Claude", redirect_uris: [CLAUDE_APPS_CALLBACK] }),
      }),
      env,
    );
    const { client_id } = (await reg.json()) as { client_id: string };
    const { challenge } = await pkcePair();
    const approve = await app.fetch(
      new Request("http://mcp.test/oauth/authorize/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supabase_token: await signSupabaseJwt("old@example.com"),
          client_id,
          redirect_uri: CLAUDE_APPS_CALLBACK,
          code_challenge: challenge,
          scope: "engram:read engram:write",
          state: "s",
          approved: true,
        }),
      }),
      env,
    );
    expect(approve.status).toBe(200);
    const orgs = (db as unknown as { _tables: Record<string, Org[]> })._tables.organizations;
    expect(orgs).toHaveLength(1);
    expect(orgs[0].referral_source).toBe("chatgpt");
  });
});
