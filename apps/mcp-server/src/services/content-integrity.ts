import {
  getR2PointerPage,
  getChunkTextsCoveringSequence,
  getMessagesBySequenceRange,
  updateMessageContent,
} from "@getengram/db";
import { loadContentOrNull, storeContent } from "./content-store.js";
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
 * one page per call, and reports the rows whose object is missing. With
 * repair on it rebuilds each missing body from the search index: a chunk
 * row keeps the verbatim window text, one `[role]: content` part per
 * message joined by newlines (packages/shared chunk.ts), and the
 * neighbours' bodies are still in R2 — so the missing message is whatever
 * remains once the neighbours are stripped off both ends. The match is
 * checked byte-for-byte before anything is written: a window that does not
 * line up is skipped, and a message no chunk can reproduce is reported,
 * never invented. The bodies are the redacted text the service stored and
 * indexed, so what comes back is exactly what a read returned before.
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
  /** Resume cursor: the last message id already checked. */
  after?: string | null;
  /** Pointers to check in this call, 1..SCAN_BATCH_MAX. */
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
  /** Pointers checked in this call. */
  scanned: number;
  /** Rows whose R2 object is missing (repaired or not). */
  missing: MessageRef[];
  repaired: Array<MessageRef & { source_chunk: string; chars: number }>;
  unrecoverable: Array<MessageRef & { reason: string }>;
  /** Missing rows cut from this call by REPAIR_MAX_PER_CALL; the cursor covers them. */
  deferred: number;
  next_after: string | null;
  done: boolean;
}

interface PointerRow {
  id: string;
  conversation_id: string;
  sequence: number;
  role: string;
  content_encoding: string | null;
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
  const page = await getR2PointerPage(
    env.DB,
    opts.organizationId,
    opts.after ?? null,
    batch,
    opts.conversationId,
  );
  const pageRows = (page.results ?? []) as PointerRow[];
  // The query selects r2:* rows; the filter keeps the invariant local.
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
    next_after: pageRows.length ? pageRows[pageRows.length - 1].id : (opts.after ?? null),
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
      result.next_after = i > 0 ? rows[i - 1].id : (opts.after ?? null);
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
    await restoreBody(env, opts.organizationId, row, rebuilt.content, rebuilt.sourceChunk);
    result.repaired.push({ ...ref, source_chunk: rebuilt.sourceChunk, chars: rebuilt.content.length });
  }

  return result;
}

/** Write a rebuilt body back exactly the way an append stores one. */
async function restoreBody(
  env: Env,
  organizationId: string,
  row: PointerRow,
  text: string,
  sourceChunk: string,
): Promise<void> {
  // storeContent falls back to inline D1 storage if the R2 put fails, and
  // the row is rewritten to match either way — so after this the pointer
  // cannot dangle.
  const { content, encoding } = await storeContent(env, row.id, text);
  await updateMessageContent(env.DB, row.id, organizationId, content, encoding);
  await audit(env.DB, organizationId, "admin", "admin.message.restore", "message", row.id, {
    conversation_id: row.conversation_id,
    sequence: row.sequence,
    source_chunk: sourceChunk,
    chars: text.length,
  });
  console.log(
    `[content-integrity] restored message ${row.id} (${text.length} chars) from chunk ${sourceChunk}`,
  );
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
  return part.slice(marker.length);
}
