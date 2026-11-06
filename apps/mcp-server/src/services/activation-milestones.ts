/**
 * Activation milestones that outlive audit_log retention (engram#555).
 *
 * The admin activation funnel and the recall nudge ask "has this org EVER…"
 * questions of audit_log, and audit_log keeps 90 days (cron/audit-retention.ts).
 * stampActivationMilestones copies each answer onto organizations (the
 * created_at of the row that first proved it), so deleting that row cannot
 * un-happen the milestone. enforceAuditRetention runs it before it deletes
 * anything, and deletes nothing if it fails.
 *
 * Cost, because D1 runs one statement at a time per database: each statement
 * is one scan of organizations (~2.6k rows) with correlated probes the
 * audit_log indexes answer per org, the same shape as the funnel (engram#553),
 * and it writes only the orgs that gained a milestone. They run as separate
 * requests, not a batch, so other queries interleave between them.
 *
 * "First" means rowid order on idx_audit_log_action. That is insertion order,
 * and so created_at order: created_at defaults to datetime('now') at insert
 * and D1 executes inserts serially. MIN(created_at) over an org's search rows
 * would read every one of them.
 */

/** The audit_log rows (alias `a`) that prove a search, and a search that recalled something. */
export const SEARCH_EVIDENCE = `a.action = 'search'`;
export const RECALL_EVIDENCE = `a.action = 'search' AND CAST(json_extract(a.metadata, '$.results') AS INTEGER) > 0`;

export const ACTIVATION_MILESTONES = [
  "first_activity",
  "first_search",
  "first_recall",
  "second_session",
  "returned_7d",
] as const;
export type ActivationMilestone = (typeof ACTIVATION_MILESTONES)[number];
export type MilestoneStamps = Record<ActivationMilestone, number>;

/**
 * In dependency order: first_recall only probes orgs with a first_search, and
 * second_session counts from first_activity, both stamped earlier in the pass.
 * Every statement skips stamped orgs (`… IS NULL`) and writes only where the
 * evidence exists, so a re-run is a no-op and a stamp never moves.
 */
const STAMPS: ReadonlyArray<{ milestone: ActivationMilestone; sql: string }> = [
  {
    milestone: "first_activity",
    sql: `UPDATE organizations
             SET first_activity_at = (
                   SELECT MIN(a.created_at) FROM audit_log a
                    WHERE a.organization_id = organizations.id
                 )
           WHERE first_activity_at IS NULL
             AND EXISTS (SELECT 1 FROM audit_log a WHERE a.organization_id = organizations.id)`,
  },
  {
    milestone: "first_search",
    sql: `UPDATE organizations
             SET first_search_at = (
                   SELECT a.created_at FROM audit_log a
                    WHERE a.organization_id = organizations.id AND ${SEARCH_EVIDENCE}
                    ORDER BY a.rowid LIMIT 1
                 )
           WHERE first_search_at IS NULL
             AND EXISTS (
                   SELECT 1 FROM audit_log a
                    WHERE a.organization_id = organizations.id AND ${SEARCH_EVIDENCE}
                 )`,
  },
  {
    milestone: "first_recall",
    sql: `UPDATE organizations
             SET first_recall_at = (
                   SELECT a.created_at FROM audit_log a
                    WHERE a.organization_id = organizations.id AND ${RECALL_EVIDENCE}
                    ORDER BY a.rowid LIMIT 1
                 )
           WHERE first_recall_at IS NULL
             AND first_search_at IS NOT NULL
             AND EXISTS (
                   SELECT 1 FROM audit_log a
                    WHERE a.organization_id = organizations.id AND ${RECALL_EVIDENCE}
                 )`,
  },
  {
    // Active on a second date: the first row dated after first_activity_at's
    // date. Counting from the stamp (not the earliest surviving row) keeps an
    // org that returns after its first day aged out still counted.
    milestone: "second_session",
    sql: `UPDATE organizations
             SET second_session_at = (
                   SELECT MIN(a.created_at) FROM audit_log a
                    WHERE a.organization_id = organizations.id
                      AND a.created_at >= date(organizations.first_activity_at, '+1 day')
                 )
           WHERE second_session_at IS NULL
             AND first_activity_at IS NOT NULL
             AND EXISTS (
                   SELECT 1 FROM audit_log a
                    WHERE a.organization_id = organizations.id
                      AND a.created_at >= date(organizations.first_activity_at, '+1 day')
                 )`,
  },
  {
    milestone: "returned_7d",
    sql: `UPDATE organizations
             SET returned_7d_at = (
                   SELECT MIN(a.created_at) FROM audit_log a
                    WHERE a.organization_id = organizations.id
                      AND a.created_at >= datetime(organizations.created_at, '+7 days')
                 )
           WHERE returned_7d_at IS NULL
             AND EXISTS (
                   SELECT 1 FROM audit_log a
                    WHERE a.organization_id = organizations.id
                      AND a.created_at >= datetime(organizations.created_at, '+7 days')
                 )`,
  },
];

/** Stamp every milestone the audit_log can still prove. Returns orgs stamped per milestone. */
export async function stampActivationMilestones(db: D1Database): Promise<MilestoneStamps> {
  const stamped = {} as MilestoneStamps;
  for (const { milestone, sql } of STAMPS) {
    const r = await db.prepare(sql).run();
    stamped[milestone] = r.meta?.changes ?? 0;
  }
  return stamped;
}
