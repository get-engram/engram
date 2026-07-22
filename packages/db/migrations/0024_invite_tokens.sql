-- Team invite tokens (engram#263): the invite email carries an unguessable
-- token; only its hash is stored, same discipline as API keys.
ALTER TABLE seats ADD COLUMN invite_token_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_seats_invite_token ON seats(invite_token_hash);
