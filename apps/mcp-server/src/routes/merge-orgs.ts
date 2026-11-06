import { Hono } from "hono";
import { orgFtsToken, reconcileOrgCounters } from "@getengram/db";
import type { Env } from "../types.js";
import { loadChunkTexts } from "../services/chunk-store.js";

/**
 * Merge one organization's data into another.
 *
 * Written for the owner's two personal accounts (a Cloudflare-era account and
 * the account they actually sign in with), but deliberately general: people
 * sign up twice, and "I have two accounts" has no answer today except support.
 *
 * The unit of work is ONE CONVERSATION, not one table. That matters because
 * the data lives in four places that must agree — D1 rows, the contentless
 * FTS index, Vectorize metadata, and (untouched) R2 — and a per-table loop
 * would leave the whole org half-moved for as long as it ran. Per conversation
 * the window of inconsistency is one conversation wide, and a crash resumes at
 * the next one.
 *
 * Idempotent by construction: every step selects on the SOURCE org id, so a
 * conversation already moved simply matches nothing on a retry.
 *
 * NOTHING IS DELETED. Rows are repointed, never removed; R2 objects are keyed
 * by message, revision or chunk id, none of which change, so the stored bodies
 * are untouched by design rather than by care.
 *
 * Ordering within a conversation is chosen so that no stage can lose data if
 * the next one never runs:
 *   1. chunks   — repoint conversation_chunks
 *   2. fts      — delete + reinsert the FTS rows under the new org token
 *   3. vectors  — rewrite Vectorize metadata (values reused, never re-embedded)
 *   4. rows     — ONE transaction: messages, the tag index, edit history,
 *                 vault entries, and the conversation row itself, LAST
 * The conversation row moves last because it is what the resume scan keys on:
 * if we die midway, the conversation is still listed as "not yet moved" and
 * the whole unit is retried. Retrying a half-moved conversation is safe (every
 * step is idempotent); skipping one would silently strand data.
 *
 * Every table that holds per-conversation rows under an organization_id must
 * be in step 4 (engram#562). The source organization is soft-deleted once a
 * merge finishes, and the purge deletes by organization_id: a row the merge
 * left behind is not orphaned, it is erased. Tag-index rows, revisions and
 * vault entries were missing from this list until #562, so merged
 * conversations fell out of tag filters and lost their edit history and
 * vault entries at purge time. The response's `left_on_source` exists so the
 * next forgotten table shows up as a non-zero count, not as a loss.
 */

type HonoEnv = { Bindings: Env; Variables: Record<string, never> };

const mergeOrgs = new Hono<HonoEnv>();

/** Vectorize getByIds rejects payloads over 20 ids (VECTOR_GET_ERROR 40007,
 *  hit in production on a 45-chunk conversation). 20 exactly. */
const VECTOR_BATCH = 20;
/** D1 bound-parameter ceiling is ~100; keep id lists under it. */
const ID_BATCH = 90;

interface OrgRow {
  id: string;
  email: string | null;
  name: string | null;
  tier: string;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function resolveOrg(env: Env, email: string): Promise<OrgRow | null> {
  return env.DB.prepare(
    "SELECT id, email, name, tier FROM organizations WHERE email = ? AND deleted_at IS NULL",
  )
    .bind(email)
    .first<OrgRow>();
}

/**
 * Move a single conversation and everything hanging off it.
 * Returns per-store counts so the caller can log real numbers rather than
 * "ok" — a merge that silently moves zero chunks is the failure we care about.
 */
async function moveConversation(
  env: Env,
  conversationId: string,
  fromOrg: string,
  toOrg: string,
): Promise<{
  chunks: number;
  vectors: number;
  messages: number;
  tags: number;
  revisions: number;
  vault: number;
}> {
  // --- 1. chunks -----------------------------------------------------------
  // Read before repointing: we need chunk_text and fts_rowid to rebuild the
  // FTS entries, and the contentless index cannot give the text back.
  // Selected by conversation under EITHER org, not just the source. This is
  // what makes a retry after a mid-conversation failure safe: if a previous
  // attempt died after repointing the chunks but before rewriting Vectorize
  // metadata (exactly what the 40007 batch-size failure did), the chunks are
  // already on the target org — a source-only filter would find nothing,
  // silently skip the vector rewrite, and strand those memories outside
  // semantic search forever.
  const chunkRows = await env.DB.prepare(
    "SELECT id, vectorize_id, fts_rowid, chunk_text, chunk_encoding FROM conversation_chunks WHERE conversation_id = ? AND organization_id IN (?, ?)",
  )
    .bind(conversationId, fromOrg, toOrg)
    .all<{
      id: string;
      vectorize_id: string | null;
      fts_rowid: number | null;
      chunk_text: string;
      chunk_encoding: string | null;
    }>();
  const chunks = chunkRows.results ?? [];

  if (chunks.length > 0) {
    // A chunk's text is in its column, or only in R2 once moved
    // (engram#384); the FTS rebuild below needs it either way. Resolved
    // before anything changes, and a gap aborts the move: reinserting ''
    // would drop that chunk from keyword search. R2 keys carry no org, so
    // the copies themselves stay where they are.
    const texts = await loadChunkTexts(
      env,
      chunks.map((c) => ({ ...c, conversation_id: conversationId })),
    );
    const unresolved = chunks.filter((c) => !texts.has(c.id)).length;
    if (unresolved > 0) {
      throw new Error(
        `chunk text unavailable for ${unresolved} chunk(s) of ${conversationId}; nothing moved`,
      );
    }

    await env.DB.prepare(
      "UPDATE conversation_chunks SET organization_id = ? WHERE conversation_id = ? AND organization_id = ?",
    )
      .bind(toOrg, conversationId, fromOrg)
      .run();

    // --- 2. FTS ------------------------------------------------------------
    // The index stores an `org` token per row. It is NOT the tenant boundary
    // (reads also filter conversation_chunks.organization_id through the join)
    // but a stale token makes the MATCH and the join disagree, and the chunk
    // becomes unfindable by keyword. Delete by rowid, reinsert under the new
    // token. contentless_delete=1 is what makes the plain DELETE legal.
    const newToken = orgFtsToken(toOrg);
    for (const batch of chunkArray(chunks, ID_BATCH)) {
      const withRowids = batch.filter((c) => c.fts_rowid !== null);
      if (withRowids.length === 0) continue;
      const ph = withRowids.map(() => "?").join(",");
      const stmts = [
        env.DB.prepare(`DELETE FROM chunks_fts_v2 WHERE rowid IN (${ph})`).bind(
          ...withRowids.map((c) => c.fts_rowid as number),
        ),
        ...withRowids.map((c) =>
          env.DB.prepare(
            "INSERT INTO chunks_fts_v2(rowid, chunk_text, org) VALUES (?, ?, ?)",
          ).bind(c.fts_rowid as number, texts.get(c.id) as string, newToken),
        ),
      ];
      await env.DB.batch(stmts);
    }
  }

  // --- 3. Vectorize --------------------------------------------------------
  // Search filters on the organization_id METADATA, so leaving it stale would
  // hide every moved chunk from semantic search. getByIds returns the stored
  // vector values, so this is a metadata rewrite — no re-embedding, no
  // Workers AI spend, and the vectors stay bit-identical.
  let vectors = 0;
  for (const batch of chunkArray(chunks, VECTOR_BATCH)) {
    // vectorize_id, NOT the chunk id. Both are chk_-prefixed, which made the
    // original mistake invisible: getByIds(chunk ids) matched nothing, so
    // every "successful" merge silently rewrote zero vectors and the moved
    // memories dropped out of semantic search. A zero here is now a real
    // signal, not the normal case.
    const ids = batch.map((c) => c.vectorize_id).filter((v): v is string => !!v);
    if (ids.length === 0) continue;
    const existing = await env.VECTORIZE.getByIds(ids);
    // Skip vectors a previous attempt already rewrote. This is what lets a
    // 5,000-chunk conversation complete across several attempts: it needs
    // ~300 upsert calls, more than Vectorize's rate window allows in a
    // single request, and without this filter every retry restarted from
    // zero and hit the same 40041 at the same depth — the giants could
    // never finish. With it, every attempt makes durable forward progress.
    const todo = existing.filter(
      (v) => (v.metadata as { organization_id?: string } | undefined)?.organization_id !== toOrg,
    );
    if (todo.length === 0) continue;
    await env.VECTORIZE.upsert(
      todo.map((v) => ({
        id: v.id,
        values: v.values,
        metadata: { ...(v.metadata ?? {}), organization_id: toOrg },
      })),
    );
    vectors += todo.length;
  }

  // --- 4. every other row, in one transaction -----------------------------
  // A D1 batch commits all or nothing, so the conversation can never be seen
  // with its header on the target and its edit history, vault entries or tag
  // index still on the source (engram#562); the header stays last in the
  // batch anyway. R2 objects are keyed by message and revision id, which do
  // not change, so the verbatim bodies need no work at all. Vault entries are
  // ciphertext under a key only the user holds: repointing them is
  // crypto-neutral, and nothing here can read them.
  //
  // INDEXED BY on the tag-index and revision updates for the reason it is on
  // messages (engram#559): given `conversation_id = ? AND organization_id = ?`
  // and no planner statistics, production seeks the single-column org index
  // and walks everything the source organization owns, per conversation
  // moved. The vault has one composite (organization_id, conversation_id)
  // index and needs no hint; conversation-scope-plans.d1.test.ts pins all
  // four plans.
  const results = await env.DB.batch([
    env.DB.prepare(
      "UPDATE messages INDEXED BY idx_messages_conv_seq SET organization_id = ? WHERE conversation_id = ? AND organization_id = ?",
    ).bind(toOrg, conversationId, fromOrg),
    env.DB.prepare(
      "UPDATE conversation_tags INDEXED BY sqlite_autoindex_conversation_tags_1 SET organization_id = ? WHERE conversation_id = ? AND organization_id = ?",
    ).bind(toOrg, conversationId, fromOrg),
    env.DB.prepare(
      "UPDATE message_revisions INDEXED BY idx_message_revisions_conv SET organization_id = ? WHERE conversation_id = ? AND organization_id = ?",
    ).bind(toOrg, conversationId, fromOrg),
    env.DB.prepare(
      "UPDATE secrets_vault SET organization_id = ? WHERE conversation_id = ? AND organization_id = ?",
    ).bind(toOrg, conversationId, fromOrg),
    // The conversation header, last (see the ordering note above).
    env.DB.prepare(
      "UPDATE conversations SET organization_id = ? WHERE id = ? AND organization_id = ?",
    ).bind(toOrg, conversationId, fromOrg),
  ]);
  const changes = (i: number) =>
    (results[i]?.meta as { changes?: number } | undefined)?.changes ?? 0;

  return {
    chunks: chunks.length,
    vectors,
    messages: changes(0),
    tags: changes(1),
    revisions: changes(2),
    vault: changes(3),
  };
}

/**
 * Named secrets belong to the organization, not to a conversation, so they
 * move once per merge rather than with each conversation. A name the target
 * already has stays behind on the source: overwriting would destroy the
 * target's value, and keeping both is impossible under
 * UNIQUE(organization_id, name). The merge reports it in `left_on_source`
 * and the source must not be deleted until someone has resolved it with the
 * user. Values are client-encrypted, so the name is all the server can
 * compare, and all it should.
 */
async function moveNamedSecrets(env: Env, fromOrg: string, toOrg: string): Promise<number> {
  const res = await env.DB.prepare(
    `UPDATE named_secrets SET organization_id = ?
      WHERE organization_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM named_secrets t
           WHERE t.organization_id = ? AND t.name = named_secrets.name
        )`,
  )
    .bind(toOrg, fromOrg, toOrg)
    .run();
  return (res.meta as { changes?: number } | undefined)?.changes ?? 0;
}

/**
 * Everything still filed under an organization, per table that the purge
 * deletes by organization_id. All zeros is the only state in which deleting
 * the source loses nothing (engram#562).
 */
async function sourceLeftovers(env: Env, orgId: string) {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM conversations       WHERE organization_id = ?) AS conversations,
       (SELECT COUNT(*) FROM messages            WHERE organization_id = ?) AS messages,
       (SELECT COUNT(*) FROM conversation_chunks WHERE organization_id = ?) AS chunks,
       (SELECT COUNT(*) FROM conversation_tags   WHERE organization_id = ?) AS tags,
       (SELECT COUNT(*) FROM message_revisions   WHERE organization_id = ?) AS revisions,
       (SELECT COUNT(*) FROM secrets_vault       WHERE organization_id = ?) AS vault,
       (SELECT COUNT(*) FROM named_secrets       WHERE organization_id = ?) AS named_secrets`,
  )
    .bind(orgId, orgId, orgId, orgId, orgId, orgId, orgId)
    .first<{
      conversations: number;
      messages: number;
      chunks: number;
      tags: number;
      revisions: number;
      vault: number;
      named_secrets: number;
    }>();
  return (
    row ?? {
      conversations: 0,
      messages: 0,
      chunks: 0,
      tags: 0,
      revisions: 0,
      vault: 0,
      named_secrets: 0,
    }
  );
}

/**
 * Conversations on an organization that are private to one of its team seats
 * (engram#264). Access to a private conversation is by seat id, and a seat
 * belongs to one organization: on the target nobody holds the source's seat
 * ids, so such a conversation would move and then be reachable by no one but
 * an admin. Whether the target's owner may read a member's private memories
 * is not a call this route can make, so the merge refuses instead
 * (engram#562). A private conversation without a seat is the owner's own and
 * moves to the target's owner like everything else.
 *
 * conversations.seat_id carries no foreign key (migration 0027), so purging
 * the source's seats can never delete a conversation, merged or not.
 */
async function countPrivateSeatConversations(env: Env, orgId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM conversations WHERE organization_id = ? AND visibility = 'private' AND seat_id IS NOT NULL",
  )
    .bind(orgId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * POST /admin/merge-orgs
 * Body: { from_email, to_email, limit? }   Query: ?dry_run=1
 *
 * Emails are supplied at call time and never written to the repo, matching the
 * convention already used by /admin/comp-internal.
 *
 * `limit` caps conversations moved per call so a large merge can be driven in
 * several requests instead of fighting the worker's CPU ceiling. Call it again
 * until `remaining` is 0 — resuming is just "run it again".
 *
 * `done` means every conversation has moved. It does NOT mean the source can
 * be deleted: only `source_empty: true` means that. Anything counted in
 * `left_on_source` would be erased by the purge (engram#562) — today that can
 * only be a named secret whose name the target already has.
 *
 * Refuses (409, nothing moved) while the source has conversations private to
 * its team members; the dry run reports them as `private_to_seats`.
 */
mergeOrgs.post("/merge-orgs", async (c) => {
  const dryRun = c.req.query("dry_run") === "1" || c.req.query("dry_run") === "true";
  const body = await c.req
    .json<{ from_email?: string; to_email?: string; limit?: number; conversation_ids?: string[] }>()
    .catch(() => ({}) as { from_email?: string; to_email?: string; limit?: number; conversation_ids?: string[] });

  const fromEmail = body.from_email?.trim();
  const toEmail = body.to_email?.trim();
  if (!fromEmail || !toEmail) {
    return c.json({ error: "from_email and to_email are required" }, 400);
  }
  if (fromEmail.toLowerCase() === toEmail.toLowerCase()) {
    return c.json({ error: "from_email and to_email are the same account" }, 400);
  }

  const [from, to] = await Promise.all([
    resolveOrg(c.env, fromEmail),
    resolveOrg(c.env, toEmail),
  ]);
  if (!from) return c.json({ error: `no live organization for ${fromEmail}` }, 404);
  if (!to) return c.json({ error: `no live organization for ${toEmail}` }, 404);

  // Everything still sitting on the source org. Re-read every call, so this
  // doubles as the resume cursor and the completion check.
  // Normal mode scans what still sits on the source org. `conversation_ids`
  // overrides that with an explicit list — the repair path for conversations
  // a buggy earlier run already moved (headers on the target org, so the
  // scan can no longer see them) that need their FTS/vector steps re-run.
  // Every step is idempotent, so re-processing a healthy conversation is a
  // no-op rather than a double-move.
  let pendingIds: string[];
  if (Array.isArray(body.conversation_ids) && body.conversation_ids.length > 0) {
    pendingIds = body.conversation_ids.filter((x): x is string => typeof x === "string");
  } else {
    const pending = await c.env.DB.prepare(
      "SELECT id FROM conversations WHERE organization_id = ? ORDER BY created_at",
    )
      .bind(from.id)
      .all<{ id: string }>();
    pendingIds = (pending.results ?? []).map((r) => r.id);
  }

  const privateToSeats = await countPrivateSeatConversations(c.env, from.id);

  if (dryRun) {
    return c.json({
      dry_run: true,
      from: {
        ...from,
        ...(await sourceLeftovers(c.env, from.id)),
        pending: pendingIds.length,
        private_to_seats: privateToSeats,
      },
      to,
      note: "Nothing was changed. R2 objects are keyed by message, revision and chunk id and are not touched by a merge.",
    });
  }

  if (privateToSeats > 0) {
    return c.json(
      {
        error:
          "The source account has conversations private to its team members. Merged, they would be unreachable on the target. Nothing was moved; resolve them with the account owner first.",
        private_to_seats: privateToSeats,
      },
      409,
    );
  }

  const limit = Math.max(1, Math.min(body.limit ?? 25, 200));
  const slice = pendingIds.slice(0, limit);

  const moved = {
    conversations: 0,
    messages: 0,
    chunks: 0,
    vectors: 0,
    tags: 0,
    revisions: 0,
    vault: 0,
    named_secrets: 0,
  };
  const failures: Array<{ conversation_id: string; error: string }> = [];

  for (const id of slice) {
    try {
      const r = await moveConversation(c.env, id, from.id, to.id);
      moved.conversations++;
      moved.messages += r.messages;
      moved.chunks += r.chunks;
      moved.vectors += r.vectors;
      moved.tags += r.tags;
      moved.revisions += r.revisions;
      moved.vault += r.vault;
    } catch (err) {
      // Keep going: one bad conversation must not strand the other 114. It
      // stays on the source org, so the next call retries it.
      failures.push({
        conversation_id: id,
        error: err instanceof Error ? err.message : String(err),
      });
      console.error(`[merge-orgs] conversation ${id} FAILED: ${err}`);
    }
  }

  // Org-level rows, once per call: idempotent, and cheap when nothing is left.
  moved.named_secrets = await moveNamedSecrets(c.env, from.id, to.id);

  // Reconcile BOTH orgs' denormalized counters from the actual rows. The move
  // above relocates messages and conversations but doesn't touch
  // messages_stored_total / conversation_count, so without this the source org
  // stays overstated and the destination understated (the cause of a merged
  // org's ~75k message undercount). COUNT-based, so it's exact and idempotent
  // across the multi-call merge.
  await reconcileOrgCounters(c.env.DB, from.id);
  await reconcileOrgCounters(c.env.DB, to.id);

  const leftovers = await sourceLeftovers(c.env, from.id);
  const sourceEmpty = Object.values(leftovers).every((n) => n === 0);

  return c.json({
    from: from.id,
    to: to.id,
    moved,
    failures,
    remaining: pendingIds.length - moved.conversations,
    done: pendingIds.length - moved.conversations === 0,
    left_on_source: leftovers,
    source_empty: sourceEmpty,
    ...(leftovers.named_secrets > 0
      ? {
          note: "Some named secrets were not moved because the target already has a secret with the same name. Resolve them with the user before deleting the source account: deleting it erases them.",
        }
      : {}),
  });
});

export { mergeOrgs, moveConversation };
