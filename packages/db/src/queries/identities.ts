/**
 * org_identities — which Supabase users (`sub`) an org belongs to.
 *
 * Written at every bind (OAuth connect, /signup, /signup/claim, CLI login) and
 * read by /signup to decide whether a sign-in is the org's own user coming
 * back through a new surface (connect silently) or a sub the org has never
 * seen (must prove the inbox). See migration 0040.
 */
export type IdentitySource =
  | "oauth"
  | "signup"
  | "claim"
  | "cli-login"
  | "profile"
  | "backfill";

export function upsertOrgIdentity(
  db: D1Database,
  organizationId: string,
  sub: string,
  email: string | null,
  source: IdentitySource,
) {
  return db
    .prepare(
      `INSERT INTO org_identities (organization_id, sub, email, source)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(organization_id, sub) DO UPDATE SET last_seen_at = datetime('now')`,
    )
    .bind(organizationId, sub, email, source)
    .run();
}

export async function hasOrgIdentity(
  db: D1Database,
  organizationId: string,
  sub: string,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS present FROM org_identities WHERE organization_id = ? AND sub = ?`)
    .bind(organizationId, sub)
    .first<{ present: number }>();
  return !!row;
}
