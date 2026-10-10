-- Pin orgs to the Supabase user that owns them (engram#475 audit, root cause R1;
-- follow-up to the #476 claim gate).
--
-- Every surface that binds a person to an org — ChatGPT/Claude connect
-- (/oauth), web signup (/signup), CLI login — authenticates through Supabase
-- and then finds-or-creates the org BY EMAIL STRING, discarding the Supabase
-- user id (`sub`). So when the same Supabase user came back through a second
-- surface, the worker could not tell them from a stranger who had typed the
-- same address, and the #476 gate fired on the legitimate owner: three users
-- in its first 48 hours, every one of them the person who created the org.
--
-- org_identities records (org, sub) at every bind. /signup consults it first:
-- a sub already on the org connects with no gate and no email. Only a sub the
-- org has never seen must prove the inbox (org_claims below). Backfilled on
-- deploy from profiles (975 exact) plus Supabase users created within 120 s
-- before their same-email org (1,161 — the connector-created orgs).
CREATE TABLE IF NOT EXISTS org_identities (
  organization_id TEXT NOT NULL,
  sub             TEXT NOT NULL,
  email           TEXT,
  source          TEXT NOT NULL, -- oauth | signup | claim | cli-login | profile | backfill
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (organization_id, sub),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_org_identities_sub ON org_identities(sub);

-- Self-service claim for the unknown-sub case. /signup emails a one-time link
-- to the org's address and POST /signup/claim redeems it: a link delivered to
-- that inbox coming back IS the inbox proof the gate asks for. Replaces
-- "email support".
--
-- Only the token HASH is stored (same discipline as api_keys and
-- student_verifications): a leaked row is not redeemable. `sub` pins the
-- claim to the Supabase user who asked for it, so a forwarded link cannot
-- bind someone else's login. Rows are kept after consumption as the trail.
CREATE TABLE IF NOT EXISTS org_claims (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  sub             TEXT NOT NULL,
  email           TEXT NOT NULL,
  token_hash      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at      TEXT NOT NULL,
  consumed_at     TEXT,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_claims_token ON org_claims(token_hash);
-- Serves the per-(org, sub) cooldown lookup and the per-org daily send cap.
CREATE INDEX IF NOT EXISTS idx_org_claims_org_created ON org_claims(organization_id, created_at);
