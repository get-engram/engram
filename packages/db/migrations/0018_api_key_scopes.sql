-- Per-API-key scopes for least-privilege access (engram#69).
--
-- Comma-separated subset of: read, write, search, delete. Existing keys
-- default to full access so nothing breaks; new keys can be minted narrower
-- (e.g. a search-only key). Enforced in the MCP tool handlers.
ALTER TABLE api_keys
  ADD COLUMN scopes TEXT NOT NULL DEFAULT 'read,write,search,delete';
