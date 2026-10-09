-- Nightly pruning (engram#469): the two DELETE sweeps need an index on the
-- column they range over, or each night scans the whole table.
--   oauth_access_tokens already has idx_oauth_access_expires;
--   oauth_refresh_tokens and audit_log did not.
-- audit_log's existing (organization_id, created_at) index cannot serve a
-- global created_at range because organization_id is the leading column.
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_expires ON oauth_refresh_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
