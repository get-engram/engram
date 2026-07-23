-- Value nudges (engram#256): milestone notices fire once per threshold
-- (highest announced stored per org), and the weekly digest email is
-- default-on with a signed one-click unsubscribe.
ALTER TABLE organizations ADD COLUMN milestone_announced INTEGER NOT NULL DEFAULT 0;
ALTER TABLE organizations ADD COLUMN digest_opt_out INTEGER NOT NULL DEFAULT 0;
