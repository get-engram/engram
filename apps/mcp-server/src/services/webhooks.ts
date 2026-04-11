import { getWebhookEndpointsByOrg, insertWebhookDelivery, updateWebhookDelivery } from "@getengram/db";
import { generateId } from "@getengram/shared";

export async function fireWebhooks(
  db: D1Database,
  organizationId: string,
  event: string,
  data: Record<string, unknown>
) {
  const result = await getWebhookEndpointsByOrg(db, organizationId);
  if (!result.results || result.results.length === 0) return;

  const endpoints = result.results.filter((ep) => {
    const events = JSON.parse((ep as { events: string }).events || "[]") as string[];
    return events.includes(event);
  });

  const payload = JSON.stringify({
    event,
    data,
    timestamp: new Date().toISOString(),
  });

  for (const ep of endpoints) {
    const endpoint = ep as { id: string; url: string; secret: string };
    const deliveryId = generateId("whd");

    await insertWebhookDelivery(db, deliveryId, endpoint.id, event, payload);

    try {
      // Sign the payload with HMAC-SHA256
      const signature = await signPayload(payload, endpoint.secret);

      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Engram-Signature": signature,
          "X-Engram-Event": event,
          "X-Engram-Delivery": deliveryId,
        },
        body: payload,
      });

      await updateWebhookDelivery(
        db,
        deliveryId,
        response.status,
        response.ok
      );
    } catch {
      await updateWebhookDelivery(db, deliveryId, 0, false);
    }
  }
}

async function signPayload(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
