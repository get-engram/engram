/**
 * Seed script — run with: npx wrangler d1 execute engram-db --local --command "..."
 * Or use this script to generate seed SQL.
 *
 * Usage: npx tsx scripts/seed.ts
 */

import { nanoid } from "nanoid";

async function hashKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function main() {
  const orgId = `org_${nanoid(21)}`;
  const orgName = "Test Organization";

  const apiKeyRaw = `engram_sk_live_${nanoid(32)}`;
  const apiKeyId = `key_${nanoid(21)}`;
  const keyHash = await hashKey(apiKeyRaw);
  const keyPrefix = apiKeyRaw.slice(0, 20);

  console.log("=== Engram Seed Data ===\n");
  console.log(`Organization ID: ${orgId}`);
  console.log(`Organization Name: ${orgName}`);
  console.log(`API Key (save this — shown once): ${apiKeyRaw}`);
  console.log(`API Key ID: ${apiKeyId}`);
  console.log(`Key Prefix: ${keyPrefix}`);
  console.log("");
  console.log("=== SQL to run ===\n");

  const sql = `
INSERT INTO organizations (id, name) VALUES ('${orgId}', '${orgName}');
INSERT INTO api_keys (id, organization_id, key_hash, key_prefix, name) VALUES ('${apiKeyId}', '${orgId}', '${keyHash}', '${keyPrefix}', 'default');
  `.trim();

  console.log(sql);
  console.log("");
  console.log("Run with:");
  console.log(`  cd apps/mcp-server`);
  console.log(`  npx wrangler d1 execute engram-db --local --command "${sql.replace(/\n/g, " ")}"`);
}

main().catch(console.error);
