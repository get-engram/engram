export function upsertNamedSecret(
  db: D1Database,
  params: {
    id: string;
    organizationId: string;
    name: string;
    encryptedValue: string;
    iv: string;
    secretType: string;
  }
) {
  return db
    .prepare(
      `INSERT INTO named_secrets (id, organization_id, name, encrypted_value, iv, secret_type)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(organization_id, name) DO UPDATE SET
         encrypted_value = excluded.encrypted_value,
         iv = excluded.iv,
         secret_type = excluded.secret_type,
         updated_at = datetime('now')`
    )
    .bind(
      params.id,
      params.organizationId,
      params.name,
      params.encryptedValue,
      params.iv,
      params.secretType
    )
    .run();
}

export function getNamedSecret(
  db: D1Database,
  organizationId: string,
  name: string
) {
  return db
    .prepare(
      "SELECT id, name, encrypted_value, iv, secret_type, created_at, updated_at FROM named_secrets WHERE organization_id = ? AND name = ?"
    )
    .bind(organizationId, name)
    .first();
}

export function listNamedSecrets(
  db: D1Database,
  organizationId: string
) {
  return db
    .prepare(
      "SELECT id, name, secret_type, created_at, updated_at FROM named_secrets WHERE organization_id = ? ORDER BY name ASC"
    )
    .bind(organizationId)
    .all();
}

export function deleteNamedSecret(
  db: D1Database,
  organizationId: string,
  name: string
) {
  return db
    .prepare(
      "DELETE FROM named_secrets WHERE organization_id = ? AND name = ?"
    )
    .bind(organizationId, name)
    .run();
}
