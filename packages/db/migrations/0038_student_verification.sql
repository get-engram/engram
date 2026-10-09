-- Student pricing (engram#471). Verification is "prove you control an
-- institutional address": we email a one-time token to the address and mark
-- the org verified when it comes back. The address itself is stored so that
-- re-verification can be addressed, and so support can see what was claimed.
ALTER TABLE organizations ADD COLUMN student_email TEXT;
ALTER TABLE organizations ADD COLUMN student_verified_at TEXT;
ALTER TABLE organizations ADD COLUMN student_expires_at TEXT;

-- Pending verifications. Only the token HASH is stored, exactly like
-- api_keys and seats.invite_token_hash — a leaked database row must not be
-- redeemable. Rows are kept after consumption as an audit trail.
CREATE TABLE IF NOT EXISTS student_verifications (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  email           TEXT NOT NULL,
  token_hash      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  consumed_at     TEXT,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_student_verifications_token
  ON student_verifications(token_hash);
CREATE INDEX IF NOT EXISTS idx_student_verifications_org
  ON student_verifications(organization_id, created_at);
-- Drives the expiry cron without scanning every org.
CREATE INDEX IF NOT EXISTS idx_organizations_student_expires
  ON organizations(student_expires_at) WHERE student_expires_at IS NOT NULL;
