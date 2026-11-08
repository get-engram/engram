import { Hono } from "hono";
import { getConnectedAppsByOrg, revokeOAuthConnection } from "@getengram/db";
import { audit } from "../services/audit.js";
import { denyExternalOAuthClient, denyUnlessFirstPartyWrite, denyUnlessOwner } from "./guards.js";
import type { Env, AuthContext } from "../types.js";

type HonoEnv = { Bindings: Env; Variables: { auth: AuthContext } };

// Dashboard-facing management of OAuth connections (e.g. ChatGPT). Mounted
// under /api/* so it's gated by the standard API-key auth middleware.
const oauthConnections = new Hono<HonoEnv>();

const CONNECTOR_REFUSAL =
  "Connected apps are managed from the Engram dashboard, not from a connected app.";

// The org's connections are its credentials, not memory: a connected app
// neither lists the others nor disconnects them (engram#603).
oauthConnections.use("*", async (c, next) => {
  const denied = denyExternalOAuthClient(c, CONNECTOR_REFUSAL);
  if (denied) return denied;
  await next();
});

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
//
// A connection is org-wide (tokens carry no seat), so disconnecting one cuts
// it off for everyone: the owner's call, with a key that can write (the #441
// floor, engram#603).
oauthConnections.delete("/:clientId", async (c) => {
  const denied =
    denyUnlessOwner(c, "Only the organization owner can disconnect apps.") ??
    denyUnlessFirstPartyWrite(c, CONNECTOR_REFUSAL);
  if (denied) return denied;
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
