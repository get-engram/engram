export function insertVaultEntries(
  db: D1Database,
  entries: Array<{
    id: string;
    organizationId: string;
    conversationId: string;
    messageId: string | null;
    secretType: string;
    encryptedValue: string;
    iv: string;
    expiresAt: string | null;
  }>
) {
  const stmts = entries.map((e) =>
    db
      .prepare(
        "INSERT INTO secrets_vault (id, organization_id, conversation_id, message_id, secret_type, encrypted_value, iv, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(
        e.id,
        e.organizationId,
        e.conversationId,
        e.messageId,
        e.secretType,
        e.encryptedValue,
        e.iv,
        e.expiresAt
      )
  );
  return db.batch(stmts);
}

export function getVaultEntriesByIds(
  db: D1Database,
  ids: string[],
  organizationId: string
) {
  if (ids.length === 0) return Promise.resolve({ results: [] as Record<string, unknown>[] });
  const placeholders = ids.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT id, encrypted_value, iv, secret_type, conversation_id, message_id, created_at FROM secrets_vault WHERE id IN (${placeholders}) AND organization_id = ? AND (expires_at IS NULL OR expires_at > datetime('now'))`
    )
    .bind(...ids, organizationId)
    .all();
}

export function getVaultEntriesByConversation(
  db: D1Database,
  conversationId: string,
  organizationId: string
) {
  return db
    .prepare(
      "SELECT id, encrypted_value, iv, secret_type, message_id, created_at FROM secrets_vault WHERE conversation_id = ? AND organization_id = ? AND (expires_at IS NULL OR expires_at > datetime('now')) ORDER BY created_at ASC"
    )
    .bind(conversationId, organizationId)
    .all();
}

export function deleteExpiredVaultEntries(db: D1Database) {
  return db
    .prepare("DELETE FROM secrets_vault WHERE expires_at IS NOT NULL AND expires_at <= datetime('now')")
    .run();
}
