-- Activation nudge (dormant re-engagement): orgs that signed up but never
-- stored a real memory get one email at the 7-day mark. Stamped here so the
-- org is never emailed twice and conversions can be measured later. Mirrors
-- maxout_nudged_at.
ALTER TABLE organizations ADD COLUMN activation_nudged_at TEXT;
