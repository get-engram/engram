import { deleteConversation } from "../services/conversation.js";
import { audit } from "../services/audit.js";
import type { Env } from "../types.js";

// Bound the daily sweep so a huge backlog can't blow the cron budget;
// anything left is picked up on subsequent days.
const MAX_DELETES_PER_ORG = 50;

/**
 * Enforce per-org retention policies (engram#289). Only orgs where an
 * admin explicitly set organizations.retention_policy_days are touched —
 * for everyone else memory never expires. Semantics: a conversation
 * whose updated_at is older than the policy window is deleted whole
 * (messages, chunks, vectors, storage accounting) via the same
 * deleteConversation path the user-facing delete uses. Keying on
 * updated_at means an actively-used conversation never expires
 * mid-thread.
 */
export async function enforceRetentionPolicies(env: Env): Promise<number> {
  const orgs = await env.DB.prepare(
    `SELECT id, retention_policy_days FROM organizations
     WHERE retention_policy_days IS NOT NULL AND deleted_at IS NULL`,
  ).all<{ id: string; retention_policy_days: number }>();

  let deleted = 0;
  for (const org of orgs.results ?? []) {
    const days = org.retention_policy_days;
    if (!Number.isInteger(days) || days < 7) continue; // defensive: never honor a foot-gun value

    const stale = await env.DB.prepare(
      `SELECT id FROM conversations
       WHERE organization_id = ?
         AND updated_at < datetime('now', '-' || ? || ' days')
       ORDER BY updated_at ASC
       LIMIT ?`,
    )
      .bind(org.id, days, MAX_DELETES_PER_ORG)
      .all<{ id: string }>();

    for (const conv of stale.results ?? []) {
      const ok = await deleteConversation(env, org.id, conv.id).catch(() => false);
      if (ok) {
        deleted++;
        await audit(
          env.DB,
          org.id,
          null,
          "conversation.retention_purge",
          "conversation",
          conv.id,
          { policy_days: days },
        ).catch(() => {});
      }
    }
  }
  return deleted;
}
