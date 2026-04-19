-- Track which messages have compressed content.
-- NULL = raw text (all existing rows), 'gzip+base64' = gzip-compressed, base64-encoded.
ALTER TABLE messages ADD COLUMN content_encoding TEXT;
