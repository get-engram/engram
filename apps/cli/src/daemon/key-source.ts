/**
 * The two pieces of the daemon's KeySource that talk to something outside
 * the process (engram#594): config.json, for the key, and the server, for
 * which earlier keys are the signed-in account's. Kept out of
 * worker-main.ts, which starts the daemon when it is imported, so they can
 * be tested.
 */

import { loadConfigStrict } from "../config.js";

/** The most key hashes one owned-keys request may carry (the server's cap). */
export const OWNED_KEYS_BATCH = 50;

/**
 * The API key in config.json. Throws when the file can't be read or parsed,
 * or holds something that isn't a key: that is not a logout (engram#594),
 * and the key in use stays until the file can be read again.
 */
export async function configuredKey(): Promise<string | undefined> {
  const { apiKey } = await loadConfigStrict();
  if (apiKey === undefined || apiKey === null || apiKey === "") return undefined;
  if (typeof apiKey !== "string") throw new Error("config.json: apiKey is not a string");
  return apiKey;
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
