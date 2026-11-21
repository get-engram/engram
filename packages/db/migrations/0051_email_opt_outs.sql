-- Addresses that unsubscribed before they had an account here (engram#781).
--
-- The finish-sign-up email goes to people who made an account on the
-- website but never got in, so they have no org, and an org's unsubscribe
-- link has nothing to name. Their link names their account on the website
-- (a Supabase user id) instead. For this campaign, campaign_sends.org_id
-- holds that user id, so those rows are what the link is looked up in:
-- keep them. The unsubscribe writes the address the email went to here.
--
-- An org made later with one of these addresses, or changed to one, starts
-- opted out of lifecycle email (packages/db, queries/organizations.ts), and
-- an org that already has the address is opted out at the click.
--
-- email is lower-cased and trimmed. user_id is the account the link named.
-- source is the campaign whose link it was.
CREATE TABLE email_opt_outs (
  email TEXT PRIMARY KEY NOT NULL,
  user_id TEXT,
  source TEXT NOT NULL,
  opted_out_at TEXT NOT NULL DEFAULT (datetime('now'))
);
