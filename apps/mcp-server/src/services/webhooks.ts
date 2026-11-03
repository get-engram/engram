import { getWebhookEndpointsByOrg, insertWebhookDelivery, updateWebhookDelivery } from "@getengram/db";
import { generateId } from "@getengram/shared";
import { validateWebhookUrl, WEBHOOK_DELIVERY_TIMEOUT_MS } from "./webhook-url.js";

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

  await Promise.all(
    endpoints.map(async (ep) => {
      const endpoint = ep as { id: string; url: string; secret: string };
      const deliveryId = generateId("whd");

      await insertWebhookDelivery(db, deliveryId, endpoint.id, event, payload);

      // The destination policy is applied again here, not only at
      // registration (engram#448): a row that predates the policy, or was
      // edited by hand, must not be grandfathered into a fetch from our
      // egress. A refused endpoint is a failed delivery, visible in the log.
      const target = validateWebhookUrl(endpoint.url);
      if (!target.ok) {
        console.warn(`[webhooks] endpoint ${endpoint.id} skipped: ${target.reason}`);
        await updateWebhookDelivery(db, deliveryId, 0, false);
        return;
      }

      try {
        const signature = await signPayload(payload, endpoint.secret);

        const response = await fetch(target.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Engram-Signature": signature,
            "X-Engram-Event": event,
            "X-Engram-Delivery": deliveryId,
          },
          body: payload,
          // A validated public URL must not be able to bounce the request
          // somewhere the validator never saw. A 3xx is a failed delivery.
          redirect: "manual",
          signal: AbortSignal.timeout(WEBHOOK_DELIVERY_TIMEOUT_MS),
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
    })
  );
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
