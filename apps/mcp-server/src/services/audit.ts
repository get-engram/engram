import { generateId } from "@getengram/shared";
import { insertAuditLog } from "@getengram/db";

export type AuditAction =
  | "search"
  | "conversation.create"
  | "conversation.read"
  | "conversation.list"
  | "conversation.delete"
  | "messages.append"
  | "account.update_email"
  | "account.delete"
  | "account.restore"
  | "privacy.update"
  | "data.export"
  | "auth.success"
  | "auth.failure"
  | "vault.resolve"
  | "vault.set"
  | "vault.get"
  | "vault.list"
  | "vault.delete"
  | "subscription.status"
  | "subscription.portal"
  | "subscription.checkout"
  | "subscription.upgrade_redirect"
  | "oauth.connection.revoked";

/**
 * Audit log entry. Never throws — audit logging should not break the
 * request if it fails — but callers MUST await it. The /mcp endpoint uses
 * a stateless transport (no ctx.waitUntil wiring through tool handlers);
 * a truly fire-and-forget call here is a race against the Workers runtime
 * tearing down the request right after the response is returned, and
 * loses that race far more often than not — in production this silently
 * dropped nearly every "search" and "messages.append" audit entry while
 * "conversation.read"/"conversation.list" (whose handlers await other
 * work first, giving the write a head start) mostly survived. Awaiting
 * costs one D1 round trip per call; that's the price of the log existing.
 */
export async function audit(
  db: D1Database,
  organizationId: string,
  apiKeyId: string | null,
  action: AuditAction,
  resourceType?: string,
  resourceId?: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await insertAuditLog(db, {
    id: generateId("aud"),
    organizationId,
    apiKeyId,
    action,
    resourceType: resourceType ?? null,
    resourceId: resourceId ?? null,
    metadata: metadata ?? {},
  }).catch((err) => {
    console.error(`[audit] Failed to log ${action}:`, err);
  });
}
