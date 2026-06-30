-- OAuth 2.1 authorization server tables.
-- Engram acts as both the OAuth Authorization Server and Resource Server so
-- MCP clients (ChatGPT, Claude, etc.) can connect without a pre-shared API key.
-- All tokens and secrets are stored as SHA-256 hashes, never in plaintext.

-- Dynamically-registered clients (RFC 7591).
CREATE TABLE IF NOT EXISTS oauth_clients (
  id TEXT PRIMARY KEY,                       -- client_id (public)
  client_secret_hash TEXT,                   -- NULL for public PKCE clients
  client_name TEXT,
  redirect_uris TEXT NOT NULL DEFAULT '[]',  -- JSON array of allowed redirect URIs
  grant_types TEXT NOT NULL DEFAULT '["authorization_code","refresh_token"]',
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Single-use authorization codes (short-lived, PKCE-bound).
CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  scope TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- Access tokens (Bearer, ~1 h).
CREATE TABLE IF NOT EXISTS oauth_access_tokens (
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- Refresh tokens (~60 d, rotated on use).
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  rotated_to TEXT,                           -- token_hash of the successor (reuse detection)
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires ON oauth_authorization_codes(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_access_org ON oauth_access_tokens(organization_id);
CREATE INDEX IF NOT EXISTS idx_oauth_access_expires ON oauth_access_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_org ON oauth_refresh_tokens(organization_id);
