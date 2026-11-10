/**
 * The two pieces of the daemon's KeySource that talk to something outside
 * the process (engram#594, engram#685): config.json, for the account (the
 * key and its server), and that server, for which earlier keys are the
 * signed-in account's. Kept out of worker-main.ts, which starts the daemon
 * when it is imported, so they can be tested.
 */

import { loadConfigStrict } from "../config.js";
import { resolveBaseUrl } from "../server-url.js";
import type { Account } from "./syncer.js";

/** The most key hashes one owned-keys request may carry (the server's cap). */
export const OWNED_KEYS_BATCH = 50;

/**
 * The account configured now (engram#685): the API key from ENGRAM_API_KEY,
 * else config.json, and its server from ENGRAM_BASE_URL, else config.json,
 * else the default (resolveBaseUrl) — both from ONE read of config.json, so
 * a key is never paired with the server of another read. With both
 * variables set the file isn't read.
 *
 * Throws when config.json is needed and can't be read or parsed, or holds
 * an apiKey that isn't a string: that is not a logout (engram#594), and not
 * the default server either. The account in use stays until the file can
 * be read again, and a daemon that hasn't read it yet sends nothing.
 */
export async function configuredAccount(): Promise<Account | undefined> {
  const envKey = process.env.ENGRAM_API_KEY || undefined;
  if (envKey && process.env.ENGRAM_BASE_URL?.trim()) {
    return { key: envKey, server: resolveBaseUrl({}) };
  }
  const config = await loadConfigStrict();
  const key = envKey ?? keyIn(config);
  return key ? { key, server: resolveBaseUrl(config) } : undefined;
}

/** The API key in config.json's settings, if any. */
function keyIn(config: { apiKey?: unknown }): string | undefined {
  const { apiKey } = config;
  if (apiKey === undefined || apiKey === null || apiKey === "") return undefined;
  if (typeof apiKey !== "string") throw new Error("config.json: apiKey is not a string");
  return apiKey;
}

/**
 * KeySource.ownedKeys: asked of the account's own server (engram#685), the
 * one everything else for the account goes to — never another read's.
 */
export function ownedKeysOf(
  fetchFn: typeof fetch = fetch,
): (account: Account, keyHashes: string[]) => Promise<string[]> {
  return (account, keyHashes) => ownedKeysAt(account.server, fetchFn)(account.key, keyHashes);
}

/**
 * KeySource.ownedKeys for the server at `baseUrl`: which of `keyHashes`
 * are fingerprints of keys of the account `key` belongs to (POST
 * /api/account/owned-keys, OWNED_KEYS_BATCH at a time).
 *
 * Only key fingerprints (the SHA-256 the server keeps of each key) are
 * sent; the key itself only authenticates the request, as on any call. A
 * refusal throws an Error carrying the HTTP `status`, which the syncer
 * acts on; anything else that goes wrong throws without one, and the
 * syncer asks again later. Only hashes that were asked about can come back.
 */
export function ownedKeysAt(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
): (key: string, keyHashes: string[]) => Promise<string[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/account/owned-keys`;
  return async (key, keyHashes) => {
    const owned: string[] = [];
    for (let i = 0; i < keyHashes.length; i += OWNED_KEYS_BATCH) {
      const batch = keyHashes.slice(i, i + OWNED_KEYS_BATCH);
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ key_hashes: batch }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 300);
        throw Object.assign(
          new Error(`checking earlier API keys failed: HTTP ${res.status}${body ? ` ${body}` : ""}`),
          { status: res.status },
        );
      }
      const answer = (await res.json().catch(() => null)) as { owned?: unknown } | null;
      if (!answer || !Array.isArray(answer.owned)) {
        throw new Error("checking earlier API keys failed: unexpected response");
      }
      const asked = new Set(batch);
      for (const h of answer.owned) {
        if (typeof h === "string" && asked.has(h)) owned.push(h);
      }
    }
    return owned;
  };
}
