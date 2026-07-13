-- Track where users came from (chatgpt, claude, cursor, cli, web, etc.)
ALTER TABLE organizations ADD COLUMN referral_source TEXT;
