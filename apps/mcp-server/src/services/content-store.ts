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
