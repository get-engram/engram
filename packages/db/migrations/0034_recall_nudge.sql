-- Recall nudge (the save->recall gap): orgs that saved a real memory but have
-- never had a search return a hit get one email showing them the payoff.
-- Measured leak (2026-08): 177 orgs saved a first memory, only 50 ever saw a
-- successful recall — the biggest drop in the funnel. Stamped so the org is
-- never emailed twice and conversions can be measured. Mirrors
-- activation_nudged_at / maxout_nudged_at.
ALTER TABLE organizations ADD COLUMN recall_nudged_at TEXT;
