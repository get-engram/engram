import { mapConcurrent } from "../utils/map-concurrent.js";
import type { Env } from "../types.js";

/**
 * Chunk text in R2 (engram#384).
 *
 * conversation_chunks.chunk_text is the search index's copy of each window
 * of a conversation, and the largest thing left in D1. It is not the
 * transcript (message bodies live in the CONTENT bucket), but it is not
 * disposable either: the content-integrity repair (engram#541) rebuilds a
 * lost message body from it. So it moves the way message content did —
 * copied, verified, and only then cleared — and never in one step.
 *
 * Layout: one object per chunk in the CHUNKS bucket, keyed
 * `<conversation_id>/<chunk_id>`, holding the chunk text verbatim (UTF-8,
 * uncompressed). Every put carries the text's SHA-256, so R2 rejects an
 * upload that arrives altered. Keying under the conversation lets a
 * conversation delete remove every object it ever had with one prefix
 * listing, including any no row points at any more.
 *
 * Stages, each its own change:
 *   1. Copy (this one). Every save puts each new chunk here as well as in
 *      D1, and the mover (chunk-mover-do.ts) copies and verifies the rows
 *      that already exist. D1 stays authoritative: chunk_encoding is NULL on
 *      every row and every reader uses the column, exactly as before.
 *   2. Clear. A row's column is emptied only after its object has been read
 *      back and compared with the column at that moment, in one guarded
 *      statement:
 *        UPDATE conversation_chunks SET chunk_text = '', chunk_encoding = 'r2:raw'
 *         WHERE id = ? AND chunk_text = ? AND chunk_encoding IS NULL
 *           AND created_at <= <now - settle window>
 *      The guard compares content, not rowid: a rowid can be reused once the
 *      highest row is deleted. The settle window covers the one race left.
 *      Chunk ids are deterministic and R2 is last-writer-wins, so a rewrite
 *      of the same chunk racing the clear could pair a new row with an older
 *      object. Every rewrite goes through INSERT OR REPLACE, which resets
 *      created_at, and puts its object in the same request; a row unchanged
 *      for the whole window has no put in flight.
 *   3. Rebuild the FTS index dense, once the rows are small.
 *
 * Readers: a row's text is in R2 only when chunk_text = '' AND
 * chunk_encoding starts with 'r2:'. Anything else reads the column.
 *
 * Deletes go to R2 first and throw, like message content: a delete that
 * fails must abort while the rows still record which keys exist.
 */

export const CHUNK_R2_ENCODING = "r2:raw";

/** R2 accepts at most this many keys in one delete call. */
const R2_DELETE_MAX = 1000;
/** Puts in flight at once from one save: a save writes a handful of chunks. */
const SAVE_PUT_CONCURRENCY = 8;
/** Reads in flight at once when resolving rows whose text is in R2. */
const READ_CONCURRENCY = 25;
/** Safety stop for the prefix sweep: 1000 pages is a million objects. */
const MAX_SWEEP_PAGES = 1000;

const CONTENT_TYPE = "text/plain; charset=utf-8";

/** The R2 key of one chunk's text. Throws on ids that could cross a prefix. */
export function chunkObjectKey(conversationId: string, chunkId: string): string {
  if (!conversationId || !chunkId || conversationId.includes("/") || chunkId.includes("/")) {
    throw new Error(`[chunk-store] refusing chunk key for ${JSON.stringify([conversationId, chunkId])}`);
  }
  return `${conversationId}/${chunkId}`;
}

/** The prefix every object of one conversation sits under. */
export function conversationChunkPrefix(conversationId: string): string {
  if (!conversationId || conversationId.includes("/")) {
    throw new Error(`[chunk-store] refusing chunk prefix for ${JSON.stringify(conversationId)}`);
  }
  return `${conversationId}/`;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** True when the row's column is empty because its text lives in R2. */
export function isTextInR2Only(row: { chunk_text: string; chunk_encoding?: string | null }): boolean {
  return row.chunk_text === "" && (row.chunk_encoding ?? "").startsWith("r2:");
}

export interface ChunkCopy {
  key: string;
  text: string;
}

export interface FailedPut {
  key: string;
  error: string;
}

/** Put one chunk's text. Throws; R2 rejects the put if the text arrived altered. */
export async function putChunkText(env: Env, key: string, text: string): Promise<void> {
  await env.CHUNKS.put(key, text, {
    sha256: await sha256Hex(text),
    httpMetadata: { contentType: CONTENT_TYPE },
  });
}

/**
 * Put each copy, retrying a failed put once. Never throws: returns the
 * copies that did not land, so the caller can count them.
 */
export async function putChunkTexts(
  env: Env,
  copies: ChunkCopy[],
  concurrency: number,
): Promise<FailedPut[]> {
  const outcomes = await mapConcurrent(copies, concurrency, async (c): Promise<FailedPut | null> => {
    try {
      await putChunkText(env, c.key, c.text);
      return null;
    } catch {
      try {
        await putChunkText(env, c.key, c.text);
        return null;
      } catch (err) {
        return { key: c.key, error: err instanceof Error ? err.message : String(err) };
      }
    }
  });
  return outcomes.filter((o): o is FailedPut => o !== null);
}

/**
 * The save path's copy: put each just-written chunk's text to R2. Never
 * throws and never fails a save — the text is in D1 too, and the mover's
 * next verify pass rewrites any copy that did not land.
 */
export async function copyChunkTextsToR2(
  env: Env,
  conversationId: string,
  chunks: Array<{ id: string; text: string }>,
): Promise<void> {
  if (chunks.length === 0) return;
  try {
    const failed = await putChunkTexts(
      env,
      chunks.map((c) => ({ key: chunkObjectKey(conversationId, c.id), text: c.text })),
      SAVE_PUT_CONCURRENCY,
    );
    if (failed.length > 0) {
      console.error(
        `[chunk-store] ${failed.length}/${chunks.length} chunk copies failed for ${conversationId}; D1 still holds the text: ${failed[0].error}`,
      );
    }
  } catch (err) {
    console.error(
      `[chunk-store] chunk copy failed for ${conversationId}; D1 still holds the text: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export interface ChunkTextRow {
  id: string;
  conversation_id: string;
  chunk_text: string;
  chunk_encoding?: string | null;
}

/**
 * Each row's text, keyed by chunk id: from the column, or from R2 for a row
 * whose column has been cleared. A row whose text cannot be read is left
 * out of the map, and the caller decides what that means — search falls
 * back to the summary, a merge refuses to move the conversation. Never
 * throws.
 */
export async function loadChunkTexts(
  env: Env,
  rows: ChunkTextRow[],
): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  const remote: ChunkTextRow[] = [];
  for (const row of rows) {
    if (isTextInR2Only(row)) remote.push(row);
    else texts.set(row.id, row.chunk_text);
  }
  if (remote.length === 0) return texts;

  await mapConcurrent(remote, READ_CONCURRENCY, async (row) => {
    if (row.chunk_encoding !== CHUNK_R2_ENCODING) {
      console.error(`[chunk-store] unknown chunk_encoding ${row.chunk_encoding} on chunk ${row.id}`);
      return;
    }
    try {
      const obj = await env.CHUNKS.get(chunkObjectKey(row.conversation_id, row.id));
      if (!obj) {
        console.error(`[chunk-store] R2 object missing for cleared chunk ${row.id}`);
        return;
      }
      texts.set(row.id, await obj.text());
    } catch (err) {
      console.error(
        `[chunk-store] R2 read failed for chunk ${row.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
  return texts;
}

/**
 * Delete these chunk objects. Throws, deliberately, for the reason
 * deleteContent does: the caller must be able to abort before the D1 rows
 * that name these keys are gone.
 */
export async function deleteChunkObjects(env: Env, keys: string[]): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < keys.length; i += R2_DELETE_MAX) {
    const batch = keys.slice(i, i + R2_DELETE_MAX);
    await env.CHUNKS.delete(batch);
    deleted += batch.length;
  }
  return deleted;
}

/**
 * Delete every chunk object of a conversation, found by prefix rather than
 * from the rows, so an object no row points at goes too. Lists from the top
 * after each delete instead of following a cursor across its own deletes.
 * Throws.
 */
export async function deleteConversationChunkObjects(
  env: Env,
  conversationId: string,
): Promise<number> {
  const prefix = conversationChunkPrefix(conversationId);
  let deleted = 0;
  let previousFirst: string | null = null;
  for (let page = 0; page < MAX_SWEEP_PAGES; page++) {
    const listed = await env.CHUNKS.list({ prefix, limit: R2_DELETE_MAX });
    const keys = listed.objects.map((o) => o.key);
    if (keys.length === 0) return deleted;
    if (keys[0] === previousFirst) {
      throw new Error(`[chunk-store] delete under ${prefix} made no progress`);
    }
    previousFirst = keys[0];
    await env.CHUNKS.delete(keys);
    deleted += keys.length;
  }
  throw new Error(`[chunk-store] more than ${MAX_SWEEP_PAGES} pages under ${prefix}`);
}
