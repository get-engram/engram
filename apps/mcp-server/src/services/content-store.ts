import { compressContent, decompressContent } from "../utils/compress.js";
import type { Env } from "../types.js";

/**
 * Message content storage. Verbatim content lives in R2 (unbounded, cheap),
 * keyed by message id; the D1 `messages` row keeps only a small pointer marker
 * in `content_encoding` and an empty `content` column. This is what keeps D1
 * off the 10 GB cap.
 *
 * content_encoding values:
 *   null | "gzip+base64"      -> legacy inline content (still in the D1 column)
 *   "r2:raw" | "r2:gzip+base64" -> content is the R2 object at content/<id>,
 *                                  stored with the named compression
 *
 * SAFETY: writes NEVER lose content. If the R2 put fails, we fall back to
 * storing the (compressed) content inline in D1 exactly as before — no space
 * savings, but the words are never dropped. Reads throw loudly if an R2 object
 * that should exist is missing, rather than silently returning empty text.
 */

const PREFIX = "content/";

const r2Key = (messageId: string) => PREFIX + messageId;

/**
 * Compress `text` and store it in R2, returning the {content, encoding} to
 * write into the D1 row. Falls back to inline D1 storage if R2 is unavailable.
 * Deterministic key (message id) => retries/backfills are idempotent overwrites.
 */
export async function storeContent(
  env: Env,
  messageId: string,
  text: string,
): Promise<{ content: string; encoding: string | null }> {
  const { content, encoding } = await compressContent(text);
  try {
    await env.CONTENT.put(r2Key(messageId), content);
    return { content: "", encoding: `r2:${encoding ?? "raw"}` };
  } catch (err) {
    // R2 unavailable — keep the content inline in D1 so nothing is lost.
    console.error(
      `[content-store] R2 put failed for ${messageId}; storing inline in D1: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { content, encoding };
  }
}

/**
 * Load a message's verbatim content, transparently handling both R2-backed
 * (new) and inline (legacy) storage.
 */
export async function loadContent(
  env: Env,
  msg: { id: string; content: string; content_encoding: string | null },
): Promise<string> {
  const enc = msg.content_encoding;
  if (enc && enc.startsWith("r2:")) {
    const obj = await env.CONTENT.get(r2Key(msg.id));
    if (!obj) {
      // A row marked r2:* must have an object; surface the inconsistency
      // loudly instead of returning empty content that looks like data loss.
      throw new Error(`[content-store] R2 object missing for message ${msg.id}`);
    }
    const stored = await obj.text();
    const realEnc = enc.slice(3); // strip "r2:"
    return decompressContent(stored, realEnc === "raw" ? null : realEnc);
  }
  // Legacy inline content (or short raw content).
  return decompressContent(msg.content, enc);
}

/**
 * Permanently remove message bodies from R2.
 *
 * Deletion previously stopped at D1 and Vectorize, so the verbatim text
 * survived in R2 forever — invisible to the owner but still stored by us,
 * which contradicts the erasure commitment in the published DPA.
 *
 * Only "r2:*"-encoded messages have an object; legacy inline rows carry
 * their content in D1 and are removed by the D1 delete itself. Passing ids
 * with no object is harmless (R2 delete is idempotent), but filtering keeps
 * the batches small and the logging honest.
 *
 * THROWS on failure, deliberately. A silent failure here means telling a
 * user their data is gone while it is not — the caller must be able to
 * abort the D1 delete, because once the rows are gone the R2 keys can no
 * longer be enumerated and the objects are unreachable garbage.
 */
export async function deleteContent(
  env: Env,
  messageIds: string[],
): Promise<number> {
  if (messageIds.length === 0) return 0;
  let deleted = 0;
  // R2 accepts up to 1000 keys per delete call.
  for (let i = 0; i < messageIds.length; i += 1000) {
    const batch = messageIds.slice(i, i + 1000).map(r2Key);
    await env.CONTENT.delete(batch);
    deleted += batch.length;
  }
  return deleted;
}
