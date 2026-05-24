-- Secrets vault: stores client-encrypted secret blobs.
-- Server is zero-knowledge — only stores ciphertext, never sees plaintext.
CREATE TABLE IF NOT EXISTS secrets_vault (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message_id      TEXT,
  secret_type     TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  iv              TEXT NOT NULL,
  expires_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_vault_org_conv
  ON secrets_vault(organization_id, conversation_id);

CREATE INDEX IF NOT EXISTS idx_vault_expires
  ON secrets_vault(expires_at)
  WHERE expires_at IS NOT NULL;
