import {
  chunkId,
  chunkMessages,
  summarizeChunk,
  type ChunkResult,
  type Message,
} from "@getengram/shared";
import {
  getChunkForRebuild,
  getMessagesBySequenceRange,
  refillChunkText,
  type ChunkForRebuild,
} from "@getengram/db";
import { CHUNK_R2_ENCODING, isTextInR2Only } from "./chunk-store.js";
import { loadContentOrNull } from "./content-store.js";
import type { Env } from "../types.js";

/**
 * Rebuilding a lost chunk from its messages (engram#567).
 *
 * Once the clear has emptied a row's column, its R2 object is the only copy
 * of the text, and a row whose object is gone has its text nowhere. But a
 * chunk is cut from its conversation's messages, and those are stored on
 * their own (the CONTENT bucket, or inline). A chunk is one window of at
 * most five consecutive messages of one append, or of one reindex, and
 * sequences only grow, so the messages now in [start_sequence,
 * end_sequence] are exactly the ones it was cut from. (Editing or deleting
 * one of them reindexes the chunk away.) Re-chunking exactly those messages
 * yields that window first: the same text, or, for a window too long for
 * one chunk, the same pieces in the same order. Messages are stored as they
 * were chunked (bounded and redacted first), so the text comes back as it
 * was.
 *
 * The verify's repair calls this for every lost row it finds. It writes
 * only when it can read every message in the window and knows which
 * re-chunked piece is the row's, and then only into a row that is still
 * cleared and still empty (refillChunkText, one guarded transaction). It
 * never touches a row that holds text.
 */

export type RebuildResult =
  /** The column holds the text again, inline; its R2 copy is still missing. */
  | { status: "rebuilt"; text: string; summaryMatched: boolean }
  /** The row was deleted, rewritten or restored since it was found lost. */
  | { status: "gone" }
  /** Nothing written: a message in the window cannot be read, or no piece is the row's. */
  | { status: "unreadable"; reason: string };

export async function rebuildLostChunk(env: Env, id: string): Promise<RebuildResult> {
  const row = await getChunkForRebuild(env.DB, id);
  if (!row || !isTextInR2Only(row)) return { status: "gone" };
  if (row.chunk_encoding !== CHUNK_R2_ENCODING) {
    return { status: "unreadable", reason: `unknown chunk_encoding ${row.chunk_encoding}` };
  }

  const window = await getMessagesBySequenceRange(
    env.DB,
    row.conversation_id,
    row.organization_id,
    row.start_sequence,
    row.end_sequence,
  );
  const stored = (window.results ?? []) as Array<Record<string, unknown>>;
  if (stored.length === 0) {
    return { status: "unreadable", reason: "no messages left in its window" };
  }
  const bodies = await Promise.all(
    stored.map((m) =>
      loadContentOrNull(env, {
        id: m.id as string,
        content: m.content as string,
        content_encoding: (m.content_encoding as string | null) ?? null,
      }),
    ),
  );
  // A missing body would come back as a placeholder anywhere else. Here it
  // stops the rebuild: a chunk made from it would hold the placeholder in
  // place of what was said.
  const unreadable = stored.findIndex((_, i) => bodies[i] === null);
  if (unreadable !== -1) {
    return { status: "unreadable", reason: `message ${String(stored[unreadable].id)} has no readable body` };
  }
  const messages = stored.map((m, i) => ({
    ...m,
    content: bodies[i] as string,
    metadata: JSON.parse((m.metadata as string) || "{}"),
  })) as unknown as Message[];

  const piece = pieceOf(row, chunkMessages(messages, { onWarn: () => {} }));
  if (!piece) return { status: "unreadable", reason: "no re-chunked piece is this row's" };

  const refilled = await refillChunkText(
    env.DB,
    {
      id: row.id,
      conversationId: row.conversation_id,
      organizationId: row.organization_id,
      text: piece.text,
      summary: summarizeChunk(piece.text),
    },
    CHUNK_R2_ENCODING,
  );
  if (!refilled) return { status: "gone" };
  return { status: "rebuilt", text: piece.text, summaryMatched: summaryMatches(row.chunk_summary, piece.text) };
}

/**
 * The re-chunked piece that is this row. Since engram#349 (Aug 2026) a
 * chunk's id is its window and its place in it, so it is found by id, and
 * a row with such an id that matches no piece is not guessed at. Before
 * that ids were random: a row is matched on its window, and where the
 * window was cut into pieces, on the summary stored with it.
 */
function pieceOf(row: ChunkForRebuild, pieces: ChunkResult[]): ChunkResult | null {
  const exact = pieces.find(
    (p) => chunkId(row.conversation_id, p.startSequence, p.endSequence, p.index) === row.id,
  );
  if (exact) return exact;
  if (row.id.startsWith(`chk_${row.conversation_id}_`)) return null;
  const same = pieces.filter(
    (p) => p.startSequence === row.start_sequence && p.endSequence === row.end_sequence,
  );
  if (same.length === 1) return same[0];
  const bySummary = same.filter((p) => summaryMatches(row.chunk_summary, p.text));
  return bySummary.length === 1 ? bySummary[0] : null;
}

/**
 * Whether a stored summary is this text's: the summary saves write
 * (summarizeChunk), or the first 200 characters that migration 0017 filled
 * in for the rows before it.
 */
function summaryMatches(stored: string | null, text: string): boolean {
  if (!stored) return false;
  return stored === summarizeChunk(text) || stored === Array.from(text).slice(0, 200).join("");
}
