-- Link API keys to seats so revoking a seat cascades to its keys
ALTER TABLE api_keys ADD COLUMN seat_id TEXT REFERENCES seats(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_seat ON api_keys(seat_id);
