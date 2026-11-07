import {
  getMessagePointerPage,
  getChunkTextsCoveringSequence,
  getMessagesBySequenceRange,
  messageExists,
} from "@getengram/db";
import { deleteContent, loadContentOrNull } from "./content-store.js";
import { encodeContent } from "../utils/compress.js";
import { loadChunkTexts } from "./chunk-store.js";
import { audit } from "./audit.js";
import { mapConcurrent } from "../utils/map-concurrent.js";
import type { Env } from "../types.js";

/**
 * Content-integrity scan and repair for R2-backed messages (engram#541).
 *
 * A `messages` row with content_encoding `r2:*` promises an object at
 * content/<id>. When the object is gone, the read path serves a placeholder
 * (content-store.ts) and nothing else notices: no error, no metric, no way
 * for the owner to learn how many messages are affected. One real case — a
 * message in an imported conversation, reported in engram#401 — sat that
 * way for two months.
 *
 * The scan HEADs every pointer in an organization (or one conversation),
 * one page of rows per call in rowid order, and reports the rows whose
 * object is missing. With
 * repair on it rebuilds each missing body from the search index: a chunk
 * row keeps the verbatim window text, one `[role]: content` part per
 * message joined by newlines (packages/shared chunk.ts), and the
 * neighbours' bodies are still in R2 — so the missing message is whatever
 * remains once the neighbours are stripped off both ends. The match is
 * checked byte-for-byte before anything is written: a window that does not
 * line up is skipped, and a message no chunk can reproduce is reported,
 * never invented. The bodies are the redacted text the service stored and
 * indexed, so what comes back is exactly what a read returned before.
 *
 * A rebuilt body only ever fills the gap: it is written create-only to the
 * key the row already names, and the row itself is never written
 * (writeBackBody). Anything that wrote a body there first wins.
 */

export const SCAN_BATCH_MAX = 500;
export const SCAN_BATCH_DEFAULT = 500;

/** HEAD requests in flight at once. */
const HEAD_CONCURRENCY = 25;

/**
 * Repairs attempted per call. Each costs a handful of subrequests (the chunk
 * and window reads, up to four neighbour GETs, the PUT, the UPDATE and the
 * audit row) on top of a page of HEADs, inside Workers' ~1000-subrequest
 * budget. Past the cap the page is cut short and `next_after` points just
 * before the first unrepaired message, so the next call resumes there.
 */
const REPAIR_MAX_PER_CALL = 40;

export interface IntegrityScanOptions {
  organizationId: string;
  /** Limit the scan to one conversation. */
  conversationId?: string;
  /**
   * Resume cursor: `next_after` from the previous call, a message rowid.
   * Rows after it are checked; null starts from the beginning.
   */
  after?: number | null;
  /**
   * Message rows to read in this call, 1..SCAN_BATCH_MAX. Inline rows are
   * read and passed over, so a call can check fewer pointers than this.
   */
  batch?: number;
  /** Rebuild and write back missing bodies. Off = report only. */
  repair?: boolean;
}

export interface MessageRef {
  id: string;
  conversation_id: string;
  sequence: number;
}

export interface IntegrityScanResult {
  /** R2 pointers checked in this call (an inline row has nothing to check). */
  scanned: number;
  /** Rows whose R2 object is missing (repaired or not). */
  missing: MessageRef[];
  repaired: Array<MessageRef & { source_chunk: string; chars: number }>;
  unrecoverable: Array<MessageRef & { reason: string }>;
  /** Missing rows cut from this call by REPAIR_MAX_PER_CALL; the cursor covers them. */
  deferred: number;
  /** The rowid to pass as `after` next; null when nothing has been read yet. */
  next_after: number | null;
  done: boolean;
}

export interface PointerRow {
  id: string;
  conversation_id: string;
  sequence: number;
  role: string;
  content_encoding: string | null;
}

/** A pointer as the scan pages it: the row plus its rowid, the cursor. */
interface PagedPointerRow extends PointerRow {
  rid: number;
}

interface ChunkWindow {
  /** Id of the first piece — what the audit row names as the source. */
  id: string;
  start: number;
  end: number;
  text: string;
}

type Rebuilt = { content: string; sourceChunk: string } | { reason: string };

const r2Key = (id: string) => `content/${id}`;

export async function scanContentIntegrity(
  env: Env,
  opts: IntegrityScanOptions,
): Promise<IntegrityScanResult> {
  const batch = Math.min(SCAN_BATCH_MAX, Math.max(1, Math.floor(opts.batch ?? SCAN_BATCH_DEFAULT)));
  const page = await getMessagePointerPage(
    env.DB,
    opts.organizationId,
    opts.after ?? null,
    batch,
    opts.conversationId,
  );
  // The page holds every message in its rowid range, so its cost is the
  // batch whatever the data (engram#561). Only an `r2:*` row promises an
  // object; an inline row has nothing to check and is passed over.
  const pageRows = (page.results ?? []) as PagedPointerRow[];
  const rows = pageRows.filter((r) => r.content_encoding?.startsWith("r2:"));

  const present = await mapConcurrent(rows, HEAD_CONCURRENCY, async (r) =>
    (await env.CONTENT.head(r2Key(r.id))) !== null,
  );

  const result: IntegrityScanResult = {
    scanned: rows.length,
    missing: [],
    repaired: [],
    unrecoverable: [],
    deferred: 0,
    next_after: pageRows.length ? pageRows[pageRows.length - 1].rid : (opts.after ?? null),
    done: pageRows.length < batch,
  };

  let attempted = 0;
  for (let i = 0; i < rows.length; i++) {
    if (present[i]) continue;
    const row = rows[i];
    const ref: MessageRef = { id: row.id, conversation_id: row.conversation_id, sequence: row.sequence };

    if (opts.repair && attempted >= REPAIR_MAX_PER_CALL) {
      // Stop the page just before this row: everything from here on is
      // re-checked (cheaply) by the next call, which repairs it.
      result.deferred = rows.slice(i).filter((_, j) => !present[i + j]).length;
      result.scanned = i;
      result.next_after = row.rid - 1;
      result.done = false;
      break;
    }

    result.missing.push(ref);
    if (!opts.repair) continue;

    attempted++;
    const rebuilt = await reconstructFromChunks(env, opts.organizationId, row);
    if ("reason" in rebuilt) {
      result.unrecoverable.push({ ...ref, reason: rebuilt.reason });
      continue;
    }
    const back = await writeBackBody(env, opts.organizationId, row, rebuilt.content, rebuilt.sourceChunk, "scan");
    if (!back.written) {
      result.unrecoverable.push({ ...ref, reason: back.reason });
      continue;
    }
    result.repaired.push({ ...ref, source_chunk: rebuilt.sourceChunk, chars: rebuilt.content.length });
  }

  return result;
}

/**
 * Rebuild one message's missing body from the chunks covering it and write
 * it back: the scan's repair, for one message (engram#572). A reindex runs
 * it before it re-chunks a window, because the window's old chunks may be
 * the last place a missing body's words are, and the reindex replaces them.
 * The same byte-for-byte checks apply: a body that cannot be rebuilt exactly
 * is reported, never invented.
 *
 * Sound only while the window's messages are the ones its chunks were cut
 * from. Once a message in it is deleted, its part of the chunk text is no
 * longer stripped as a neighbour's and would be taken for the missing body,
 * so a delete runs this before it removes anything.
 *
 * `written` says whether the body is back in storage. The words come back
 * either way, for the caller to keep in the new chunks: a failed write
 * leaves the body as missing as it was, and a body something else wrote in
 * the meantime is left as it is.
 */
export async function restoreMissingBody(
  env: Env,
  organizationId: string,
  row: PointerRow,
): Promise<{ content: string; written: boolean } | { reason: string }> {
  const rebuilt = await reconstructFromChunks(env, organizationId, row);
  if ("reason" in rebuilt) return rebuilt;
  const back = await writeBackBody(env, organizationId, row, rebuilt.content, rebuilt.sourceChunk, "reindex");
  return { content: rebuilt.content, written: back.written };
}

type WriteBack = { written: true } | { written: false; reason: string };

/**
 * Put a rebuilt body back at the key its row names, only if nothing is
 * there. The scan is an operator action, audited as the admin; a reindex's
 * restore is the service's own, audited with no key.
 *
 * Only ever fills the gap (engram#572). A rebuild takes a while, and the
 * message can change under it: an edit writes its new body to this same
 * key, and an unconditional put would replace the new words with the old
 * ones. So the put is create-only, an `If-None-Match: *` precondition R2
 * checks atomically: if a body got there first, nothing is written and the
 * rebuilt one is dropped. And the row is never written: it already names
 * the object and the encoding it is in, so the body is encoded to match. A
 * row update could land after an edit's and point the row at an encoding
 * its new body is not in.
 *
 * Never throws. A failed write leaves the body missing, as it was.
 */
async function writeBackBody(
  env: Env,
  organizationId: string,
  row: PointerRow,
  text: string,
  sourceChunk: string,
  via: "scan" | "reindex",
): Promise<WriteBack> {
  const key = r2Key(row.id);
  const enc = row.content_encoding ?? "";
  let stored: boolean;
  try {
    if (!enc.startsWith("r2:")) throw new Error(`not an R2 pointer (${enc || "inline"})`);
    const body = await encodeContent(text, enc.slice(3));
    stored = (await env.CONTENT.put(key, body, { onlyIf: { etagDoesNotMatch: "*" } })) !== null;
  } catch (err) {
    const reason = `writing the rebuilt body failed: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[content-integrity] message ${row.id}: ${reason}`);
    return { written: false, reason };
  }
  if (!stored) {
    const reason = "a body was written to it while it was rebuilt; left as it is";
    console.warn(`[content-integrity] message ${row.id}: ${reason}`);
    return { written: false, reason };
  }

  // A delete of the message meanwhile can have removed its object before
  // the put above created it again. With the row gone for good nothing
  // would ever read or delete that object, so remove it now.
  try {
    if (!(await messageExists(env.DB, row.id))) {
      await deleteContent(env, [row.id]);
      console.warn(`[content-integrity] message ${row.id} was deleted while its body was rebuilt; removed the body again`);
      return { written: false, reason: "the message was deleted while its body was rebuilt" };
    }
  } catch (err) {
    console.error(
      `[content-integrity] message ${row.id}: checking the row after the write-back failed; the body stays: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  await audit(
    env.DB,
    organizationId,
    via === "scan" ? "admin" : null,
    via === "scan" ? "admin.message.restore" : "message.restore",
    "message",
    row.id,
    {
      conversation_id: row.conversation_id,
      sequence: row.sequence,
      source_chunk: sourceChunk,
      chars: text.length,
    },
  );
  console.log(
    `[content-integrity] restored message ${row.id} (${text.length} chars) from chunk ${sourceChunk}${
      via === "reindex" ? " before a reindex" : ""
    }`,
  );
  return { written: true };
}

/** Trailing `_<n>` of a chunk id: the piece index of a hard-split message. */
function pieceIndex(chunkId: string): number {
  const m = /_(\d+)$/.exec(chunkId);
  return m ? Number(m[1]) : 0;
}

async function reconstructFromChunks(
  env: Env,
  organizationId: string,
  row: PointerRow,
): Promise<Rebuilt> {
  const res = await getChunkTextsCoveringSequence(
    env.DB,
    row.conversation_id,
    organizationId,
    row.sequence,
  );
  const covering = (res.results ?? []).filter(
    (c) => c.start_sequence <= row.sequence && row.sequence <= c.end_sequence,
  );
  if (covering.length === 0) {
    return { reason: "no chunk covers this message (never indexed, or its chunks were dropped)" };
  }
  // A chunk's text is in its column, or only in R2 once moved (engram#384).
  const texts = await loadChunkTexts(env, covering);

  // Chunks sharing a [start,end] range are the pieces of one oversized
  // message, split by characters; in piece order they concatenate back to
  // its `[role]: content` part. Every other range is a distinct window.
  const byRange = new Map<string, typeof covering>();
  for (const c of covering) {
    const key = `${c.start_sequence}:${c.end_sequence}`;
    const list = byRange.get(key);
    if (list) list.push(c);
    else byRange.set(key, [c]);
  }
  const failures: string[] = [];
  const windows: ChunkWindow[] = [];
  for (const pieces of byRange.values()) {
    pieces.sort((a, b) => pieceIndex(a.id) - pieceIndex(b.id));
    // A window missing any piece's text would rebuild a truncated message,
    // and a restore writes what it rebuilds. Skip it rather than guess.
    const missing = pieces.filter((p) => !texts.has(p.id));
    if (missing.length > 0) {
      failures.push(`${pieces[0].id}: chunk text unavailable for ${missing.length} piece(s)`);
      continue;
    }
    windows.push({
      id: pieces[0].id,
      start: pieces[0].start_sequence,
      end: pieces[0].end_sequence,
      text: pieces.map((p) => texts.get(p.id)!).join(""),
    });
  }
  // Fewest neighbours first: a narrow window has the least that can fail.
  windows.sort((a, b) => a.end - a.start - (b.end - b.start));

  for (const w of windows) {
    const outcome = await extractFromWindow(env, organizationId, row, w);
    if (typeof outcome === "string") return { content: outcome, sourceChunk: w.id };
    failures.push(`${w.id}: ${outcome.reason}`);
  }
  return { reason: failures.join("; ") };
}

/**
 * Strip the neighbours' parts off a chunk window and return what is left
 * for the target message — or why that cannot be done safely.
 */
async function extractFromWindow(
  env: Env,
  organizationId: string,
  row: PointerRow,
  w: ChunkWindow,
): Promise<string | { reason: string }> {
  const windowRes = await getMessagesBySequenceRange(
    env.DB,
    row.conversation_id,
    organizationId,
    w.start,
    w.end,
  );
  const neighbours = (windowRes.results as Array<Record<string, unknown>>)
    .filter((m) => (m.sequence as number) >= w.start && (m.sequence as number) <= w.end)
    .sort((a, b) => (a.sequence as number) - (b.sequence as number));
  if (!neighbours.some((m) => m.id === row.id)) {
    return { reason: "the message is not in its own window" };
  }

  const before: string[] = [];
  const after: string[] = [];
  let passedTarget = false;
  for (const m of neighbours) {
    if (m.id === row.id) {
      passedTarget = true;
      continue;
    }
    const body = await loadContentOrNull(env, {
      id: m.id as string,
      content: m.content as string,
      content_encoding: m.content_encoding as string | null,
    });
    if (body === null) return { reason: `neighbour ${m.id} is missing too` };
    (passedTarget ? after : before).push(`[${m.role}]: ${body}`);
  }

  const prefix = before.length ? before.join("\n") + "\n" : "";
  const suffix = after.length ? "\n" + after.join("\n") : "";
  if (
    w.text.length < prefix.length + suffix.length ||
    !w.text.startsWith(prefix) ||
    !w.text.endsWith(suffix)
  ) {
    return { reason: "neighbours do not match the chunk text (stale chunk?)" };
  }

  const part = w.text.slice(prefix.length, w.text.length - suffix.length);
  const marker = `[${row.role}]: `;
  if (!part.startsWith(marker)) {
    return { reason: "the remaining text does not start with this message's role marker" };
  }
  const body = part.slice(marker.length);

  // A message deleted from this window after the chunk was cut (its reindex
  // failed, or was held back to keep a missing body's words, engram#572)
  // still has its part in the text and no row to strip it as. Next to the
  // target, that part is left over with the target's own, and would be
  // written back as part of the target's body. Such a leftover always shows
  // twice: a sequence missing beside the target (sequences are handed out
  // one by one, so a gap is a deletion), and a line in the rebuilt body that
  // starts like a message's part. Both together refuse the rebuild. A body
  // that merely quotes a transcript is refused too when a neighbour was
  // deleted; that keeps it missing, and its chunks, rather than guess.
  const at = neighbours.findIndex((m) => m.id === row.id);
  const prev = at > 0 ? (neighbours[at - 1].sequence as number) : w.start - 1;
  const next = at < neighbours.length - 1 ? (neighbours[at + 1].sequence as number) : w.end + 1;
  if ((row.sequence - prev > 1 || next - row.sequence > 1) && /\n\[[^\]\n]*\]: /.test(body)) {
    return {
      reason:
        "a neighbour was deleted and the rebuilt text has a line that starts like a message, so it may hold the deleted message's text",
    };
  }
  return body;
}
