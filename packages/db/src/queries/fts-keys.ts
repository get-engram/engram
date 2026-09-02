/**
 * Key derivation for the contentless FTS5 index (migration 0035).
 *
 * A contentless FTS table cannot return column values — a MATCH gives back
 * rowids and nothing else. So each chunk needs a stable integer rowid that we
 * can store alongside it and join on afterwards.
 */

/**
 * Deterministic 53-bit rowid for a chunk.
 *
 * Derived from the chunk id rather than allocated, so re-indexing the same
 * window (chunk ids are already deterministic — see chunkId()) produces the
 * same rowid and overwrites in place instead of duplicating.
 *
 * FNV-1a, folded to 53 bits so the value stays inside JavaScript's exact
 * integer range. SQLite rowids are 64-bit, but a value that loses precision in
 * JS would silently address the wrong row.
 *
 * Collision risk at 571k chunks is about 1.8e-5 (birthday bound over 2^53).
 * A collision merges two chunks' terms in the keyword index — it cannot lose
 * a message, since the text of record lives in conversation_chunks and R2, and
 * semantic search is unaffected.
 */
export function ftsRowid(chunkId: string): number {
  // 64-bit FNV-1a using two 32-bit halves; JS bitwise ops are 32-bit only.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < chunkId.length; i++) {
    const c = chunkId.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  // Fold to 53 bits: 21 high bits from h1, 32 low bits from h2.
  const folded = (h1 >>> 11) * 0x100000000 + h2;
  // rowid 0 is legal but easy to confuse with "unset"; shift it off zero.
  return folded === 0 ? 1 : folded;
}

/**
 * Org identifier reduced to a single FTS token.
 *
 * FTS5's default unicode61 tokenizer splits on non-alphanumerics, so an id
 * like `org_Osnqdz3Hhf7RZZNk2dnBW` would index as two tokens — `org` plus the
 * rest — and every organization would share the `org` token, making the column
 * filter useless. Stripping the separators yields one token per org.
 *
 * This is a search *hint*, not an authorization boundary: two ids could in
 * principle collapse to the same token (`org_ab-cd` and `org_abcd`). Callers
 * MUST still filter on conversation_chunks.organization_id in the join. The
 * token narrows the index scan; the join is what guarantees correctness.
 */
export function orgFtsToken(organizationId: string): string {
  return organizationId.replace(/[^A-Za-z0-9]/g, "");
}

/**
 * Build the MATCH expression for a scoped keyword search.
 *
 * Produces `org:<token> AND (<user query>)`, so FTS5 prunes to one
 * organization inside the index instead of returning every org's matches for
 * a common word and discarding them afterwards.
 *
 * The user's query is embedded as-is, preserving today's behaviour where FTS5
 * operators (AND/OR/NOT, prefix*, "phrases") work. A malformed query raises an
 * FTS5 syntax error exactly as it does today, and search.ts already catches
 * that and degrades to semantic-only.
 *
 * SAFETY: this is not the tenant boundary. A crafted query could in principle
 * break the grouping, and two org ids could collapse to the same token — which
 * is why every caller also filters on conversation_chunks.organization_id in
 * the join. The token is an optimisation; the join is the guarantee.
 */
export function ftsMatch(query: string, organizationId: string): string {
  return `org:${orgFtsToken(organizationId)} AND (${query})`;
}
