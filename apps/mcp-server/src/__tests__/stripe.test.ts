import { describe, it, expect } from "vitest";
import { verifyWebhookSignature } from "../services/stripe.js";

// Compute a valid Stripe signature the same way Stripe does, so we can
// exercise the verifier without needing real Stripe traffic.
async function signStripePayload(
  secret: string,
  body: string,
  timestamp: number,
): Promise<string> {
  const payload = `${timestamp}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  const hex = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `t=${timestamp},v1=${hex}`;
}

describe("verifyWebhookSignature", () => {
  const secret = "whsec_test_abc123";
  const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });

  it("accepts a fresh, correctly signed payload", async () => {
    const now = Math.floor(Date.now() / 1000);
    const header = await signStripePayload(secret, body, now);
    expect(await verifyWebhookSignature(body, header, secret)).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const now = Math.floor(Date.now() / 1000);
    const header = await signStripePayload(secret, body, now);
    const tampered = body.replace("evt_1", "evt_2");
    expect(await verifyWebhookSignature(tampered, header, secret)).toBe(false);
  });

  it("rejects a payload signed with a different secret", async () => {
    const now = Math.floor(Date.now() / 1000);
    const header = await signStripePayload("whsec_wrong", body, now);
    expect(await verifyWebhookSignature(body, header, secret)).toBe(false);
  });

  it("rejects a stale timestamp (replay protection)", async () => {
    const stale = Math.floor(Date.now() / 1000) - 10 * 60; // 10 minutes ago
    const header = await signStripePayload(secret, body, stale);
    expect(await verifyWebhookSignature(body, header, secret)).toBe(false);
  });

  it("rejects a malformed signature header", async () => {
    expect(await verifyWebhookSignature(body, "garbage", secret)).toBe(false);
    expect(await verifyWebhookSignature(body, "", secret)).toBe(false);
  });

  it("accepts when one of multiple v1 signatures matches (secret rotation)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const good = await signStripePayload(secret, body, now);
    const goodHex = good.split("v1=")[1];
    const header = `t=${now},v1=0000000000000000000000000000000000000000000000000000000000000000,v1=${goodHex}`;
    expect(await verifyWebhookSignature(body, header, secret)).toBe(true);
  });
});
