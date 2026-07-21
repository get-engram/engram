-- API request metering (engram#287): count authenticated data-plane
-- requests (/mcp + /api/v1) per org per period, alongside the existing
-- messages_stored / searches_run counters.
ALTER TABLE usage ADD COLUMN api_requests INTEGER NOT NULL DEFAULT 0;
