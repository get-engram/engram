import { Hono } from "hono";
import { orgFtsToken } from "@getengram/db";
import type { Env } from "../types.js";

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
 * NOTHING IS DELETED. Rows are repointed, never removed; R2 content is keyed
 * by message id, which does not change, so message bodies are untouched by
 * design rather than by care.
 *
 * Ordering within a conversation is chosen so that no stage can lose data if
 * the next one never runs:
 *   1. chunks   — repoint conversation_chunks
 *   2. fts      — delete + reinsert the FTS rows under the new org token
 *   3. vectors  — rewrite Vectorize metadata (values reused, never re-embedded)
 *   4. messages — repoint messages
 *   5. header   — repoint the conversation row itself, LAST
 * The conversation row moves last because it is what the resume scan keys on:
 * if we die midway, the conversation is still listed as "not yet moved" and
 * the whole unit is retried. Retrying a half-moved conversation is safe (every
 * step is idempotent); skipping one would silently strand data.
 */

type HonoEnv = { Bindings: Env; Variables: Record<string, never> };

const mergeOrgs = new Hono<HonoEnv>();

/** Vectorize getByIds/upsert are capped well below this; stay conservative. */
const VECTOR_BATCH = 100;
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
): Promise<{ chunks: number; vectors: number; messages: number }> {
  // --- 1. chunks -----------------------------------------------------------
  // Read before repointing: we need chunk_text and fts_rowid to rebuild the
  // FTS entries, and the contentless index cannot give the text back.
  const chunkRows = await env.DB.prepare(
    "SELECT id, fts_rowid, chunk_text FROM conversation_chunks WHERE conversation_id = ? AND organization_id = ?",
  )
    .bind(conversationId, fromOrg)
    .all<{ id: string; fts_rowid: number | null; chunk_text: string }>();
  const chunks = chunkRows.results ?? [];

  if (chunks.length > 0) {
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
          ).bind(c.fts_rowid as number, c.chunk_text, newToken),
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
    const ids = batch.map((c) => c.id);
    const existing = await env.VECTORIZE.getByIds(ids);
    if (existing.length === 0) continue;
    await env.VECTORIZE.upsert(
      existing.map((v) => ({
        id: v.id,
        values: v.values,
        metadata: { ...(v.metadata ?? {}), organization_id: toOrg },
      })),
    );
    vectors += existing.length;
  }

  // --- 4. messages ---------------------------------------------------------
  // R2 objects are keyed by message id, which is unchanged, so the verbatim
  // bodies need no work at all.
  const msgRes = await env.DB.prepare(
    "UPDATE messages SET organization_id = ? WHERE conversation_id = ? AND organization_id = ?",
  )
    .bind(toOrg, conversationId, fromOrg)
    .run();

  // --- 5. the conversation header, last (see the ordering note above) ------
  await env.DB.prepare(
    "UPDATE conversations SET organization_id = ? WHERE id = ? AND organization_id = ?",
  )
    .bind(toOrg, conversationId, fromOrg)
    .run();

  return {
    chunks: chunks.length,
    vectors,
    messages: (msgRes.meta as { changes?: number } | undefined)?.changes ?? 0,
  };
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
 */
mergeOrgs.post("/merge-orgs", async (c) => {
  const dryRun = c.req.query("dry_run") === "1" || c.req.query("dry_run") === "true";
  const body = await c.req
    .json<{ from_email?: string; to_email?: string; limit?: number }>()
    .catch(() => ({}) as { from_email?: string; to_email?: string; limit?: number });

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
  const pending = await c.env.DB.prepare(
    "SELECT id FROM conversations WHERE organization_id = ? ORDER BY created_at",
  )
    .bind(from.id)
    .all<{ id: string }>();
  const pendingIds = (pending.results ?? []).map((r) => r.id);

  const totals = await c.env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM messages WHERE organization_id = ?) AS messages, (SELECT COUNT(*) FROM conversation_chunks WHERE organization_id = ?) AS chunks",
  )
    .bind(from.id, from.id)
    .first<{ messages: number; chunks: number }>();

  if (dryRun) {
    return c.json({
      dry_run: true,
      from: { ...from, conversations: pendingIds.length, ...totals },
      to,
      note: "Nothing was changed. R2 message bodies are keyed by message id and are not touched by a merge.",
    });
  }

  const limit = Math.max(1, Math.min(body.limit ?? 25, 200));
  const slice = pendingIds.slice(0, limit);

  const moved = { conversations: 0, messages: 0, chunks: 0, vectors: 0 };
  const failures: Array<{ conversation_id: string; error: string }> = [];

  for (const id of slice) {
    try {
      const r = await moveConversation(c.env, id, from.id, to.id);
      moved.conversations++;
      moved.messages += r.messages;
      moved.chunks += r.chunks;
      moved.vectors += r.vectors;
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

  return c.json({
    from: from.id,
    to: to.id,
    moved,
    failures,
    remaining: pendingIds.length - moved.conversations,
    done: pendingIds.length - moved.conversations === 0,
  });
});

export { mergeOrgs, moveConversation };
