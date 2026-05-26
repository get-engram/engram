import { generateId } from "@getengram/shared";
import { insertAuditLog } from "@getengram/db";

export type AuditAction =
  | "search"
  | "conversation.create"
  | "conversation.read"
  | "conversation.list"
  | "conversation.delete"
  | "messages.append"
  | "account.delete"
  | "account.restore"
  | "data.export"
  | "auth.success"
  | "auth.failure"
  | "vault.resolve"
  | "vault.set"
  | "vault.get"
  | "vault.list"
  | "vault.delete";

/**
 * Fire-and-forget audit log entry. Never throws — audit logging
 * should not break the request if it fails.
 */
export function audit(
  db: D1Database,
  organizationId: string,
  apiKeyId: string | null,
  action: AuditAction,
  resourceType?: string,
  resourceId?: string,
  metadata?: Record<string, unknown>,
) {
  insertAuditLog(db, {
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
