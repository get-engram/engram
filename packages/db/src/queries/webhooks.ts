export function insertWebhookEndpoint(
  db: D1Database,
  id: string,
  organizationId: string,
  url: string,
  events: string[],
  secret: string
) {
  return db
    .prepare(
      "INSERT INTO webhook_endpoints (id, organization_id, url, events, secret) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(id, organizationId, url, JSON.stringify(events), secret)
    .run();
}

export function getWebhookEndpointsByOrg(db: D1Database, organizationId: string) {
  return db
    .prepare("SELECT * FROM webhook_endpoints WHERE organization_id = ? AND active = 1")
    .bind(organizationId)
    .all();
}

export function getWebhookEndpointById(db: D1Database, id: string, organizationId: string) {
  return db
    .prepare("SELECT * FROM webhook_endpoints WHERE id = ? AND organization_id = ?")
    .bind(id, organizationId)
    .first();
}

export function getWebhookEndpointCount(db: D1Database, organizationId: string) {
  return db
    .prepare("SELECT COUNT(*) as count FROM webhook_endpoints WHERE organization_id = ? AND active = 1")
    .bind(organizationId)
    .first<{ count: number }>();
}

export function deleteWebhookEndpoint(db: D1Database, id: string, organizationId: string) {
  return db
    .prepare("UPDATE webhook_endpoints SET active = 0 WHERE id = ? AND organization_id = ?")
    .bind(id, organizationId)
    .run();
}

export function getWebhookEndpointsForEvent(db: D1Database, organizationId: string, event: string) {
  // SQLite JSON — check if events array contains the event
  return db
    .prepare(
      `SELECT * FROM webhook_endpoints
       WHERE organization_id = ? AND active = 1
       AND json_each.value = ?`
    )
    .bind(organizationId, event)
    .all()
    .catch(() => {
      // Fallback: fetch all and filter in JS (D1 json_each can be tricky)
      return db
        .prepare("SELECT * FROM webhook_endpoints WHERE organization_id = ? AND active = 1")
        .bind(organizationId)
        .all();
    });
}

export function insertWebhookDelivery(
  db: D1Database,
  id: string,
  webhookEndpointId: string,
  event: string,
  payload: string
) {
  return db
    .prepare(
      "INSERT INTO webhook_deliveries (id, webhook_endpoint_id, event, payload) VALUES (?, ?, ?, ?)"
    )
    .bind(id, webhookEndpointId, event, payload)
    .run();
}

export function updateWebhookDelivery(
  db: D1Database,
  id: string,
  statusCode: number,
  delivered: boolean
) {
  return db
    .prepare(
      `UPDATE webhook_deliveries
       SET status_code = ?, attempts = attempts + 1, last_attempted_at = datetime('now'),
           delivered_at = CASE WHEN ? THEN datetime('now') ELSE delivered_at END
       WHERE id = ?`
    )
    .bind(statusCode, delivered ? 1 : 0, id)
    .run();
}
