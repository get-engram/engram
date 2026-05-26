-- Named secrets: explicit key-value secret storage with client-side encryption.
-- Secrets are encrypted by the client (AES-256-GCM) before transmission.
-- Server stores opaque blobs — zero-knowledge.

CREATE TABLE IF NOT EXISTS named_secrets (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  iv TEXT NOT NULL,
  secret_type TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  UNIQUE(organization_id, name)
);

CREATE INDEX idx_named_secrets_org ON named_secrets(organization_id);
CREATE INDEX idx_named_secrets_org_name ON named_secrets(organization_id, name);
