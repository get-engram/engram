ALTER TABLE organizations ADD COLUMN email TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_email ON organizations(email);
