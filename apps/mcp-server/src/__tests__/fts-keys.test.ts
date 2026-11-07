import { describe, it, expect } from "vitest";
import {
  ftsRowid,
  orgFtsToken,
  ftsMatch,
  FTS_MAX_TERMS,
  FTS_MAX_PHRASES,
  FTS_MAX_PHRASE_TOKENS,
  FTS_MAX_QUERY_CHARS,
} from "@getengram/db";

/**
 * A contentless FTS5 index returns rowids and nothing else, so these three
 * functions are the entire bridge between a MATCH result and the chunk it
 * came from. If any of them is unstable, keyword search silently returns the
 * wrong rows or none at all.
 */
describe("ftsRowid", () => {
  it("is deterministic — re-indexing a window must overwrite, not duplicate", () => {
    const id = "chk_conv_abc_10_20_0";
    expect(ftsRowid(id)).toBe(ftsRowid(id));
  });

  it("stays inside JavaScript's exact integer range", () => {
    // A rowid past 2^53 loses precision in JS and would address a different
    // row than the one written.
    for (const id of ["a", "chk_x", "chk_" + "z".repeat(200), "🙂"]) {
      const r = ftsRowid(id);
      expect(Number.isSafeInteger(r)).toBe(true);
      expect(r).toBeGreaterThan(0);
    }
  });

  it("separates ids that differ only slightly", () => {
    expect(ftsRowid("chk_conv_a_1_2_0")).not.toBe(ftsRowid("chk_conv_a_1_2_1"));
    expect(ftsRowid("chk_conv_a_1_2_0")).not.toBe(ftsRowid("chk_conv_b_1_2_0"));
  });

  it("has no collisions across a realistic id space", () => {
    // Shape mirrors chunkId(): conversation + sequence window + index.
    const seen = new Set<number>();
    for (let conv = 0; conv < 200; conv++) {
      for (let seq = 0; seq < 50; seq++) {
        seen.add(ftsRowid(`chk_conv_${conv}_${seq * 6}_${seq * 6 + 5}_0`));
      }
    }
    expect(seen.size).toBe(200 * 50);
  });
});

describe("orgFtsToken", () => {
  it("collapses an org id to a single FTS token", () => {
    // unicode61 splits on non-alphanumerics, so `org_Abc` would index as
    // `org` + `abc` and EVERY org would share the `org` token.
    expect(orgFtsToken("org_Osnqdz3Hhf7RZZNk2dnBW")).toBe("orgOsnqdz3Hhf7RZZNk2dnBW");
    expect(orgFtsToken("org_a-b_c")).toMatch(/^[A-Za-z0-9]+$/);
  });

  it("is stable for the same id", () => {
    expect(orgFtsToken("org_x-y")).toBe(orgFtsToken("org_x-y"));
  });
});

/** The org part every MATCH starts with, for org_abc. */
const ORG = 'org:"orgabc" AND chunk_text:';
const terms = (...t: string[]) => `${ORG}(${t.map((x) => `"${x}"`).join(" AND ")})`;

/** The quoted terms of a MATCH, after the org conjunct. */
function termsOf(match: string): string[] {
  return [...match.slice(ORG.length).matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

/** Exactly the shape ftsMatch promises: the org conjunct, then one
 *  parenthesized AND of quoted strings, each only tokens and single spaces. */
const SHAPE = /^org:"[A-Za-z0-9]+" AND chunk_text:\("[^"]+"(?: AND "[^"]+")*\)$/;
const TERM = /^[\p{L}\p{N}\p{Co}][\p{L}\p{N}\p{Co}\p{M}]*(?: [\p{L}\p{N}\p{Co}][\p{L}\p{N}\p{Co}\p{M}]*)*$/u;

describe("ftsMatch (engram#564)", () => {
  it("scopes every query to one org inside the index", () => {
    expect(ftsMatch("deploy", "org_abc")).toBe(terms("deploy"));
  });

  it("ANDs the words, as FTS5 does for plain words", () => {
    expect(ftsMatch("deploy worker", "org_abc")).toBe(terms("deploy", "worker"));
    expect(ftsMatch("  deploy\n\tworker  ", "org_abc")).toBe(terms("deploy", "worker"));
  });

  it("returns null when nothing in the query can narrow a search", () => {
    for (const q of ["", "   ", "the", "what did we do", "user", "assistant", "!!! ???", '"" * ^ ()', "a b c", "don't", "é"]) {
      expect(ftsMatch(q, "org_abc"), q).toBeNull();
    }
  });

  it("drops stopwords and role labels as whole terms, but not inside a phrase", () => {
    expect(ftsMatch("how do I deploy the worker", "org_abc")).toBe(terms("deploy", "worker"));
    expect(ftsMatch("user assistant deploy", "org_abc")).toBe(terms("deploy"));
    expect(ftsMatch("user-id", "org_abc")).toBe(terms("user id"));
    expect(ftsMatch("state-of-the-art", "org_abc")).toBe(terms("state of the art"));
    expect(ftsMatch('"rock and roll"', "org_abc")).toBe(terms("rock and roll"));
  });

  it("trims stopwords off the edges of a phrase, quoted or not", () => {
    expect(ftsMatch("Antonia's notes", "org_abc")).toBe(terms("Antonia", "notes"));
    expect(ftsMatch("it's broken", "org_abc")).toBe(terms("broken"));
    expect(ftsMatch('"the deploy script"', "org_abc")).toBe(terms("deploy script"));
    expect(ftsMatch('"of the"', "org_abc")).toBeNull();
  });

  it("keeps a phrase only when it has a token that narrows", () => {
    expect(ftsMatch('"user is"', "org_abc")).toBeNull();
    // A one-character token can sit in a phrase that has a real word in it.
    expect(ftsMatch("x-ray", "org_abc")).toBe(terms("x ray"));
    expect(ftsMatch("a.b", "org_abc")).toBeNull();
    // Phrases with nothing to narrow on: role labels, one-character tokens.
    // Each is costly to evaluate and matches nearly everything it can.
    expect(ftsMatch('"user assistant"', "org_abc")).toBeNull();
    expect(ftsMatch("1.2.3", "org_abc")).toBeNull();
    expect(ftsMatch("x-y-z", "org_abc")).toBeNull();
    expect(ftsMatch("version 1.2.3", "org_abc")).toBe(terms("version"));
  });

  it("turns paths, versions and ids into phrases", () => {
    expect(ftsMatch("src/app.ts", "org_abc")).toBe(terms("src app ts"));
    expect(ftsMatch("v1.2.3", "org_abc")).toBe(terms("v1 2 3"));
    expect(ftsMatch("engram-wt-569", "org_abc")).toBe(terms("engram wt 569"));
  });

  it("neutralizes operators, prefixes, column filters and grouping", () => {
    // Prefix search is not offered: its cost has no bound (it merges every
    // matching token's doclist across all organizations).
    expect(ftsMatch('pref* OR "exact phrase"', "org_abc")).toBe(terms("pref", "exact phrase"));
    expect(ftsMatch("NOT secret", "org_abc")).toBe(terms("secret"));
    expect(ftsMatch("NEAR(alpha beta, 3)", "org_abc")).toBe(terms("NEAR alpha", "beta"));
    expect(ftsMatch("^start +plus -minus", "org_abc")).toBe(terms("start", "plus", "minus"));
    expect(ftsMatch("org:orgother chunk_text:secret", "org_abc")).toBe(terms("org orgother", "chunk text secret"));
    expect(ftsMatch("{org chunk_text}:x", "org_abc")).toBe(terms("org", "chunk text x"));
    expect(ftsMatch("C++ foo:bar (unbalanced", "org_abc")).toBe(terms("foo bar", "unbalanced"));
    // An unmatched quote is a space: it splits words, never joins them.
    expect(ftsMatch('kestrel"osprey', "org_abc")).toBe(terms("kestrel", "osprey"));
    expect(ftsMatch('"heron" kestrel"osprey', "org_abc")).toBe(terms("heron", "kestrel", "osprey"));
    expect(ftsMatch('odd "quote count', "org_abc")).toBe(terms("odd", "quote", "count"));
  });

  it("cannot regroup the org conjunct", () => {
    for (const q of [
      'x") OR (org:"orgother',
      "x) OR org:orgother OR (y",
      '") OR ("',
      "* OR org:*",
      'x" OR "y',
    ]) {
      const m = ftsMatch(q, "org_abc");
      if (m === null) continue;
      expect(m, q).toMatch(SHAPE);
      expect(m.startsWith(ORG + "("), q).toBe(true);
      expect(m.match(/org:/g)?.length, q).toBe(1);
      expect(m.match(/[()]/g), q).toEqual(["(", ")"]);
    }
  });

  it("caps the number of terms and of phrases", () => {
    const words = Array.from({ length: 20 }, (_, i) => `word${i}`);
    const m = ftsMatch(words.join(" "), "org_abc")!;
    expect(termsOf(m)).toEqual(words.slice(0, FTS_MAX_TERMS));

    const paths = Array.from({ length: 6 }, (_, i) => `dir${i}/file${i}.ts`);
    const p = ftsMatch([...paths, "alpha", "beta"].join(" "), "org_abc")!;
    const got = termsOf(p);
    expect(got.filter((t) => t.includes(" "))).toEqual(
      paths.slice(0, FTS_MAX_PHRASES).map((x) => x.replace(/[/.]/g, " ")),
    );
    // Later single words still count once the phrase cap is reached.
    expect(got.slice(-2)).toEqual(["alpha", "beta"]);
  });

  it("caps the length of a phrase", () => {
    const long = Array.from({ length: 20 }, (_, i) => `t${i}`).join("-");
    const m = ftsMatch(long, "org_abc")!;
    expect(termsOf(m)).toEqual([Array.from({ length: FTS_MAX_PHRASE_TOKENS }, (_, i) => `t${i}`).join(" ")]);
  });

  it("counts a repeated term once, across case and accents", () => {
    expect(ftsMatch("Deploy deploy DEPLOY déploy", "org_abc")).toBe(terms("Deploy"));
    expect(ftsMatch("src/app.ts SRC-APP-TS", "org_abc")).toBe(terms("src app ts"));
  });

  it("keeps accents and non-Latin scripts", () => {
    expect(ftsMatch("José São Paulo", "org_abc")).toBe(terms("José", "São", "Paulo"));
    expect(ftsMatch("привет мир", "org_abc")).toBe(terms("привет", "мир"));
    expect(ftsMatch("東京タワー", "org_abc")).toBe(terms("東京タワー"));
    expect(ftsMatch("¿Cómo está el despliegue?", "org_abc")).toBe(terms("despliegue"));
  });

  it("reads at most FTS_MAX_QUERY_CHARS characters", () => {
    const m = ftsMatch("x".repeat(FTS_MAX_QUERY_CHARS) + " needle", "org_abc")!;
    expect(termsOf(m)).toEqual(["x".repeat(FTS_MAX_QUERY_CHARS)]);
  });

  it("refuses an org id with nothing the index can hold", () => {
    expect(() => ftsMatch("deploy", "___")).toThrow();
  });

  it("always has the promised shape, whatever the input", () => {
    // Seeded so a failure reproduces.
    let seed = 0x5640;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pieces = [
      "a", "deploy", "É", "Z9", "_", "-", ".", ":", "*", "^", '"', "(", ")", "{", "}", "+", " ", "  ", "\t", "\n",
      "NEAR", "AND", "OR", "NOT", "col:", "org:", "chunk_text:", "the", "user", "ж", "東", "🙂", "́", "",
      "'", "’", ",", "/", "\\", "\u0000", "\uD800", "0", "s",
    ];
    let nonNull = 0;
    for (let i = 0; i < 3000; i++) {
      const n = Math.floor(rand() * 40);
      let q = "";
      for (let j = 0; j < n; j++) q += pieces[Math.floor(rand() * pieces.length)];
      const m = ftsMatch(q, "org_abc");
      if (m === null) continue;
      nonNull++;
      expect(m, JSON.stringify(q)).toMatch(SHAPE);
      const ts = termsOf(m);
      expect(ts.length).toBeLessThanOrEqual(FTS_MAX_TERMS);
      expect(ts.filter((t) => t.includes(" ")).length).toBeLessThanOrEqual(FTS_MAX_PHRASES);
      for (const t of ts) {
        expect(t, JSON.stringify(q)).toMatch(TERM);
        expect(t.split(" ").length).toBeLessThanOrEqual(FTS_MAX_PHRASE_TOKENS);
      }
    }
    // The generator must actually exercise the non-null path.
    expect(nonNull).toBeGreaterThan(500);
  });

  it("documents that the token is not the tenant boundary", () => {
    // These two distinct org ids collapse to the same token. That is
    // ACCEPTABLE only because every caller also filters on
    // conversation_chunks.organization_id in the join — this test exists to
    // make that dependency explicit rather than incidental.
    expect(orgFtsToken("org_ab-cd")).toBe(orgFtsToken("org_abcd"));
  });
});
