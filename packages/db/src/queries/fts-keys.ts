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

/** Characters of query text the keyword builder reads. The search routes
 *  already reject longer queries (MAX_SEARCH_QUERY_CHARS in @getengram/shared);
 *  this keeps the builder bounded on its own. */
export const FTS_MAX_QUERY_CHARS = 4096;
/** Most terms one keyword query keeps (engram#564). */
export const FTS_MAX_TERMS = 8;
/** Most multi-token phrases among those terms — see ftsMatch for why
 *  phrases are the expensive kind. */
export const FTS_MAX_PHRASES = 3;
/** Most tokens kept from one phrase. */
export const FTS_MAX_PHRASE_TOKENS = 8;

/**
 * Words too common to narrow a search. Each one matches a large share of all
 * chunks, so as a term it adds index work without excluding anything. English
 * plus Spanish and Portuguese, our other common query languages; contraction
 * fragments (`s`, `t`, `don`, `isn`) are here because `don't` and `Antonia's`
 * tokenize into them. Stored folded (no accents, lower case). Words that are
 * also everyday technical terms (`os`, `dos`, `num`, `todo`, `uno`) are
 * deliberately absent.
 */
const STOPWORDS = new Set(
  `
  i me my myself we our ours ourselves you your yours yourself yourselves he him his himself she her hers herself
  it its itself they them their theirs themselves what which who whom this that these those am is are was were be
  been being have has had having do does did doing a an the and but if or because as until while of at by for with
  about against between into through during before after above below to from up down in out on off over under again
  further then once here there when where why how all any both each few more most other some such no nor not only own
  same so than too very can will just should now cannot would could also please thanks yes ok okay
  s t d ll m o re ve y ain aren couldn didn doesn don hadn hasn haven isn ma mightn mustn needn shan shouldn wasn
  weren won wouldn

  de la que el en y a los del se las por un para con no una su al lo como más pero sus le ya o este sí porque esta
  entre cuando muy sin sobre también me hasta hay donde quien desde nos durante les ni contra otros
  ese eso ante ellos e esto mí antes algunos qué unos yo otro otras otra él tanto esa estos mucho quienes nada muchos
  cual poco ella estar estas algunas algo nosotros tu tú te ti tus ellas nosotras vosotros mío mía tuyo tuya suyo
  suya nuestro nuestra vuestro vuestra esos esas estoy estás está estamos están es son era fue ser soy eres somos
  han ha he has hemos había tengo tiene tienen

  do da em um é com não uma no na mais as ao ele das tem à seu sua ou quando muito há já eu só pelo pela até
  isso depois sem mesmo aos ter seus nas esse eles estão você tinha foram essa nem suas meu às minha têm numa
  pelos elas havia seja qual será nós lhe deles essas esses pelas fosse dele vocês vos lhes meus minhas teu tua
  nosso nossa dela delas estes aquele aquela isto aquilo estou estava
  `
    .split(/\s+/)
    .filter(Boolean)
    .map(fold),
);

/** Every chunk is stored as `[role]: content`, so these two tokens are in
 *  nearly all of them: as a whole term they match everything. Inside a phrase
 *  (`user-id`) they are ordinary words. */
const ROLE_LABELS = new Set(["user", "assistant"]);

/**
 * A token as FTS5's default `unicode61` tokenizer sees one: it starts with a
 * letter, number or private-use character, and combining marks may continue
 * it. Everything else (spaces, punctuation, quotes, `*`, `^`, `:`, `(`, `-`)
 * separates tokens, which is why none of it can survive into the MATCH text.
 */
const TOKEN = /[\p{L}\p{N}\p{Co}][\p{L}\p{N}\p{Co}\p{M}]*/gu;

interface Token {
  /** The characters as typed; this is what goes into the MATCH text. */
  text: string;
  /** Folded form, for stopword checks and de-duplication only. */
  key: string;
}

function fold(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
}

function tokenize(s: string): Token[] {
  return [...s.matchAll(TOKEN)].map((m) => ({ text: m[0], key: fold(m[0]) }));
}

const isStopword = (t: Token) => STOPWORDS.has(t.key);

/** A token that narrows a search: two or more characters, not a stopword,
 *  not a role label. */
const isContent = (t: Token) => [...t.key].length >= 2 && !isStopword(t) && !ROLE_LABELS.has(t.key);

/** The query split into units: each double-quoted span is one unit, and the
 *  rest splits on whitespace. An unmatched quote is ignored. */
function units(query: string): string[] {
  const text = query.slice(0, FTS_MAX_QUERY_CHARS);
  const out: string[] = [];
  const words = (s: string) => {
    for (const w of s.split(/\s+/)) if (w) out.push(w);
  };
  let at = 0;
  while (at < text.length) {
    const open = text.indexOf('"', at);
    const close = open === -1 ? -1 : text.indexOf('"', open + 1);
    if (close === -1) {
      words(text.slice(at).replace(/"/g, " "));
      break;
    }
    words(text.slice(at, open));
    out.push(text.slice(open + 1, close));
    at = close + 1;
  }
  return out;
}

/** One unit as a term (one token, or a phrase of several), or null when it
 *  cannot narrow the search. */
function term(unit: string): Token[] | null {
  let toks = tokenize(unit);
  // `the deploy`, `Antonia's`, `don't`: stopwords at the edges of a phrase
  // only make it costlier to evaluate. Words inside one (`state of the art`)
  // are kept: they are what makes it that phrase.
  const trimEdges = () => {
    let a = 0;
    let b = toks.length;
    while (a < b && isStopword(toks[a])) a++;
    while (b > a && isStopword(toks[b - 1])) b--;
    toks = toks.slice(a, b);
  };
  trimEdges();
  if (toks.length > FTS_MAX_PHRASE_TOKENS) {
    toks = toks.slice(0, FTS_MAX_PHRASE_TOKENS);
    trimEdges();
  }
  if (toks.length === 0) return null;
  if (toks.length === 1) return isContent(toks[0]) ? toks : null;
  return toks.some(isContent) ? toks : null;
}

/**
 * Build the MATCH expression for a scoped keyword search, or null when the
 * query has no term worth searching for (then there is nothing to run).
 *
 * The result is always exactly
 *
 *     org:"<org token>" AND chunk_text:("<term>" AND "<term>" ...)
 *
 * built from tokens, never from the query text itself (engram#564):
 *
 * - Every term is a double-quoted string holding only token characters and
 *   single spaces. User text cannot add an operator, a column filter, a
 *   prefix `*`, a parenthesis or a quote, so no query is a syntax error and no
 *   query can regroup the expression around the org conjunct. A query that
 *   used to fail with a syntax error (`C++`, `foo:bar`, an odd quote) now
 *   searches its words.
 * - Prefix search is not offered. `foo*` merges the doclist of every token
 *   starting with `foo` across all organizations, and its cost has no bound.
 * - Terms are ANDed, as FTS5 does for plain words. Stopwords and the role
 *   labels are dropped as whole terms; there are at most FTS_MAX_TERMS terms,
 *   and repeats count once.
 * - A word made of several tokens (`engram-wt-569`, `src/app.ts`, `v1.2.3`)
 *   or a quoted span becomes one phrase. bm25's IDF reads every chunk that
 *   holds all of a phrase's tokens, in every organization, and checks their
 *   positions, so phrases are the expensive kind of term: at most
 *   FTS_MAX_PHRASES, at most FTS_MAX_PHRASE_TOKENS tokens each, and each one
 *   must contain at least one token that is not a stopword or role label.
 *
 * Searching is still bounded per query by the probe in searchChunksFts, which
 * declines to rank a query that matches too many of the organization's chunks.
 *
 * SAFETY: the org conjunct is a search hint, not the tenant boundary. Two org
 * ids can collapse to the same token (see orgFtsToken), which is why every
 * caller also filters on conversation_chunks.organization_id in the join. The
 * token keeps the index work to one organization; the join is the guarantee.
 */
export function ftsMatch(query: string, organizationId: string): string | null {
  const org = orgFtsToken(organizationId);
  if (!org) throw new Error("organization id has no characters the keyword index can hold");
  const seen = new Set<string>();
  const terms: string[] = [];
  let phrases = 0;
  for (const unit of units(query)) {
    if (terms.length >= FTS_MAX_TERMS) break;
    const toks = term(unit);
    if (!toks) continue;
    const key = toks.map((t) => t.key).join(" ");
    if (seen.has(key)) continue;
    if (toks.length > 1) {
      if (phrases >= FTS_MAX_PHRASES) continue;
      phrases++;
    }
    seen.add(key);
    terms.push(`"${toks.map((t) => t.text).join(" ")}"`);
  }
  if (terms.length === 0) return null;
  return `org:"${org}" AND chunk_text:(${terms.join(" AND ")})`;
}
