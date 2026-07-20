import { Hono } from "hono";
import { getConnectedAppsByOrg, revokeOAuthConnection } from "@getengram/db";
import { audit } from "../services/audit.js";
import type { Env, AuthContext } from "../types.js";

type HonoEnv = { Bindings: Env; Variables: { auth: AuthContext } };

// Dashboard-facing management of OAuth connections (e.g. ChatGPT). Mounted
// under /api/* so it's gated by the standard API-key auth middleware.
const oauthConnections = new Hono<HonoEnv>();

interface ConnectionRow {
  client_id: string;
  client_name: string;
  authorized_at: string;
  expires_at: string;
}

// List the apps connected to this org via OAuth.
oauthConnections.get("/", async (c) => {
  const auth = c.get("auth");
  const result = await getConnectedAppsByOrg(c.env.DB, auth.organizationId);
  const connections = (result.results as unknown as ConnectionRow[]).map((r) => ({
    client_id: r.client_id,
    client_name: r.client_name,
    authorized_at: r.authorized_at,
  }));
  return c.json({ connections });
});

// Revoke this org's connection to a client — deletes its access tokens and
// revokes its refresh tokens. The app must re-authorize to reconnect.
oauthConnections.delete("/:clientId", async (c) => {
  const auth = c.get("auth");
  const clientId = c.req.param("clientId");

  await revokeOAuthConnection(c.env.DB, auth.organizationId, clientId);

  await audit(
    c.env.DB,
    auth.organizationId,
    auth.apiKeyId,
    "oauth.connection.revoked",
    "oauth_client",
    clientId,
  );

  return c.json({ revoked: true });
});

export { oauthConnections };
