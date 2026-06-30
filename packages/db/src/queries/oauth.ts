// OAuth 2.1 storage queries. Tokens/secrets are passed in already hashed
// (SHA-256) by the caller — this layer never sees plaintext.

// ---------------------------------------------------------------------------
// Clients (Dynamic Client Registration, RFC 7591)
// ---------------------------------------------------------------------------

export function insertOAuthClient(
  db: D1Database,
  id: string,
  clientSecretHash: string | null,
  clientName: string | null,
  redirectUris: string[],
  grantTypes: string[],
  tokenEndpointAuthMethod: string,
) {
  return db
    .prepare(
      `INSERT INTO oauth_clients
         (id, client_secret_hash, client_name, redirect_uris, grant_types, token_endpoint_auth_method)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      clientSecretHash,
      clientName,
      JSON.stringify(redirectUris),
      JSON.stringify(grantTypes),
      tokenEndpointAuthMethod,
    )
    .run();
}

export function getOAuthClient(db: D1Database, clientId: string) {
  return db
    .prepare("SELECT * FROM oauth_clients WHERE id = ?")
    .bind(clientId)
    .first<{
      id: string;
      client_secret_hash: string | null;
      client_name: string | null;
      redirect_uris: string;
      grant_types: string;
      token_endpoint_auth_method: string;
      created_at: string;
    }>();
}

// ---------------------------------------------------------------------------
// Authorization codes (single-use, PKCE-bound)
// ---------------------------------------------------------------------------

export function insertAuthorizationCode(
  db: D1Database,
  codeHash: string,
  clientId: string,
  organizationId: string,
  redirectUri: string,
  codeChallenge: string,
  codeChallengeMethod: string,
  scope: string,
  expiresAt: string,
) {
  return db
    .prepare(
      `INSERT INTO oauth_authorization_codes
         (code_hash, client_id, organization_id, redirect_uri, code_challenge, code_challenge_method, scope, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      codeHash,
      clientId,
      organizationId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
      scope,
      expiresAt,
    )
    .run();
}

export function getAuthorizationCode(db: D1Database, codeHash: string) {
  return db
    .prepare(
      `SELECT * FROM oauth_authorization_codes
       WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > datetime('now')`,
    )
    .bind(codeHash)
    .first<{
      code_hash: string;
      client_id: string;
      organization_id: string;
      redirect_uri: string;
      code_challenge: string;
      code_challenge_method: string;
      scope: string;
      expires_at: string;
    }>();
}

export function consumeAuthorizationCode(db: D1Database, codeHash: string) {
  return db
    .prepare(
      "UPDATE oauth_authorization_codes SET consumed_at = datetime('now') WHERE code_hash = ?",
    )
    .bind(codeHash)
    .run();
}

// ---------------------------------------------------------------------------
// Access tokens
// ---------------------------------------------------------------------------

export function insertAccessToken(
  db: D1Database,
  tokenHash: string,
  clientId: string,
  organizationId: string,
  scope: string,
  expiresAt: string,
) {
  return db
    .prepare(
      `INSERT INTO oauth_access_tokens (token_hash, client_id, organization_id, scope, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(tokenHash, clientId, organizationId, scope, expiresAt)
    .run();
}

/**
 * Single-query auth lookup mirroring getApiKeyWithOrg: joins access token →
 * organization to return org ID and tier in one round trip, only if unexpired.
 */
export function getAccessTokenWithOrg(db: D1Database, tokenHash: string) {
  return db
    .prepare(
      `SELECT t.token_hash, t.client_id, t.organization_id, t.scope, o.tier
       FROM oauth_access_tokens t
       JOIN organizations o ON o.id = t.organization_id
       WHERE t.token_hash = ? AND t.expires_at > datetime('now')`,
    )
    .bind(tokenHash)
    .first<{
      token_hash: string;
      client_id: string;
      organization_id: string;
      scope: string;
      tier: string;
    }>();
}

// ---------------------------------------------------------------------------
// Refresh tokens (rotated on use)
// ---------------------------------------------------------------------------

export function insertRefreshToken(
  db: D1Database,
  tokenHash: string,
  clientId: string,
  organizationId: string,
  scope: string,
  expiresAt: string,
) {
  return db
    .prepare(
      `INSERT INTO oauth_refresh_tokens (token_hash, client_id, organization_id, scope, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(tokenHash, clientId, organizationId, scope, expiresAt)
    .run();
}

export function getRefreshToken(db: D1Database, tokenHash: string) {
  return db
    .prepare("SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?")
    .bind(tokenHash)
    .first<{
      token_hash: string;
      client_id: string;
      organization_id: string;
      scope: string;
      expires_at: string;
      rotated_to: string | null;
      revoked_at: string | null;
    }>();
}

/** Mark a refresh token as rotated to a successor (used during refresh). */
export function rotateRefreshToken(
  db: D1Database,
  tokenHash: string,
  successorHash: string,
) {
  return db
    .prepare(
      "UPDATE oauth_refresh_tokens SET rotated_to = ?, revoked_at = datetime('now') WHERE token_hash = ?",
    )
    .bind(successorHash, tokenHash)
    .run();
}

/**
 * Revoke every refresh token for a client+org pair. Called on refresh-token
 * reuse detection (a token already rotated/revoked is presented again).
 */
export function revokeRefreshTokenChain(
  db: D1Database,
  clientId: string,
  organizationId: string,
) {
  return db
    .prepare(
      "UPDATE oauth_refresh_tokens SET revoked_at = datetime('now') WHERE client_id = ? AND organization_id = ? AND revoked_at IS NULL",
    )
    .bind(clientId, organizationId)
    .run();
}

// ---------------------------------------------------------------------------
// Connected apps (dashboard "manage access")
// ---------------------------------------------------------------------------

/**
 * List the OAuth apps an org has an active connection to. A connection is a
 * live (non-revoked, unexpired) refresh token — the durable grant that
 * outlives the 1-hour access tokens. One row per client.
 */
export function getConnectedAppsByOrg(db: D1Database, organizationId: string) {
  return db
    .prepare(
      `SELECT c.id AS client_id,
              COALESCE(c.client_name, 'Application') AS client_name,
              MAX(r.created_at) AS authorized_at,
              MAX(r.expires_at) AS expires_at
       FROM oauth_refresh_tokens r
       JOIN oauth_clients c ON c.id = r.client_id
       WHERE r.organization_id = ?
         AND r.revoked_at IS NULL
         AND r.expires_at > datetime('now')
       GROUP BY c.id, c.client_name
       ORDER BY authorized_at DESC`,
    )
    .bind(organizationId)
    .all();
}

/**
 * Revoke an org's connection to a client: delete its access tokens and revoke
 * its refresh tokens. The app must re-run the OAuth flow to reconnect.
 */
export function revokeOAuthConnection(
  db: D1Database,
  organizationId: string,
  clientId: string,
) {
  return db.batch([
    db
      .prepare(
        "DELETE FROM oauth_access_tokens WHERE organization_id = ? AND client_id = ?",
      )
      .bind(organizationId, clientId),
    db
      .prepare(
        "UPDATE oauth_refresh_tokens SET revoked_at = datetime('now') WHERE organization_id = ? AND client_id = ? AND revoked_at IS NULL",
      )
      .bind(organizationId, clientId),
  ]);
}
