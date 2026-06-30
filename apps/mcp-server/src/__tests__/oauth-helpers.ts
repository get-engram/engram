import { vi } from "vitest";

// A small in-memory D1 fake that actually honors the queries the OAuth flow
// uses (hash-PK lookups, consumed_at/revoked_at flags, expiry comparisons, and
// the access-token→organization join). The shared createMockD1 is too coarse
// for security-sensitive flows like PKCE replay and refresh rotation.

interface D1Result {
  results: unknown[];
  success: boolean;
  meta: Record<string, unknown>;
}

type Row = Record<string, unknown>;

function nowStr(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

export function createOAuthD1(): D1Database {
  const tables: Record<string, Row[]> = {};
  const table = (name: string) => (tables[name] ??= []);

  // Pull `<col> = ?` equalities (in order) and recognized literal predicates.
  function parseWhere(sql: string, args: unknown[]) {
    const whereSql = sql.split(/\bWHERE\b/i)[1] ?? "";
    const eqCols = [...whereSql.matchAll(/([\w.]+)\s*=\s*\?/g)].map((m) =>
      m[1].includes(".") ? m[1].split(".")[1] : m[1],
    );
    const eq: Record<string, unknown> = {};
    eqCols.forEach((col, i) => (eq[col] = args[i]));
    return {
      eq,
      consumedNull: /consumed_at\s+IS\s+NULL/i.test(whereSql),
      revokedNull: /revoked_at\s+IS\s+NULL/i.test(whereSql),
      unexpired: /expires_at\s*>\s*datetime\('now'\)/i.test(whereSql),
    };
  }

  function matches(row: Row, w: ReturnType<typeof parseWhere>): boolean {
    for (const [col, val] of Object.entries(w.eq)) {
      if (row[col] !== val) return false;
    }
    if (w.consumedNull && row.consumed_at != null) return false;
    if (w.revokedNull && row.revoked_at != null) return false;
    if (w.unexpired && !(String(row.expires_at) > nowStr())) return false;
    return true;
  }

  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    run: vi.fn(async (): Promise<D1Result> => {
      const insert = sql.match(/INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES/i);
      if (insert) {
        const cols = insert[2].split(",").map((c) => c.trim());
        const row: Row = {};
        cols.forEach((c, i) => (row[c] = args[i] ?? null));
        table(insert[1]).push(row);
        return { results: [], success: true, meta: {} };
      }
      const update = sql.match(/UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s/is);
      if (update) {
        const [, name, setClause] = update;
        const w = parseWhere(sql, args);
        // SET assignments consume leading `?` args; WHERE consumes the rest.
        const assigns = setClause.split(",").map((s) => s.trim());
        let argPtr = 0;
        const setters: Array<[string, unknown]> = [];
        for (const a of assigns) {
          const [col, expr] = a.split("=").map((s) => s.trim());
          if (expr === "?") setters.push([col, args[argPtr++]]);
          else if (/datetime\('now'\)/i.test(expr)) setters.push([col, nowStr()]);
          else setters.push([col, expr.replace(/^'|'$/g, "")]);
        }
        // Re-parse WHERE using only the args after the SET placeholders.
        const w2 = parseWhere(sql, args.slice(argPtr));
        void w;
        for (const row of table(name)) {
          if (matches(row, w2)) for (const [c, v] of setters) row[c] = v;
        }
        return { results: [], success: true, meta: {} };
      }
      const del = sql.match(/DELETE\s+FROM\s+(\w+)\s+WHERE\s/is);
      if (del) {
        const name = del[1];
        const w = parseWhere(sql, args);
        tables[name] = table(name).filter((r) => !matches(r, w));
        return { results: [], success: true, meta: {} };
      }
      return { results: [], success: true, meta: {} };
    }),
    first: vi.fn(async () => {
      const from = sql.match(/FROM\s+(\w+)/i);
      if (!from) return null;
      const w = parseWhere(sql, args);
      const found = table(from[1]).find((r) => matches(r, w));
      if (!found) return null;
      // Access-token lookup joins organizations for the tier column.
      if (/JOIN\s+organizations/i.test(sql)) {
        const org = table("organizations").find((o) => o.id === found.organization_id);
        return { ...found, tier: org?.tier ?? "free" };
      }
      return found;
    }),
    all: vi.fn(async (): Promise<D1Result> => {
      const from = sql.match(/FROM\s+(\w+)/i);
      if (!from) return { results: [], success: true, meta: {} };
      const w = parseWhere(sql, args);
      const rows = table(from[1]).filter((r) => matches(r, w));
      // Connected-apps query: JOIN oauth_clients + GROUP BY client. Shape the
      // rows like the real SELECT (client_id, client_name, authorized_at) and
      // dedup by client_id to mimic GROUP BY.
      if (/JOIN\s+oauth_clients/i.test(sql)) {
        const byClient = new Map<string, Row>();
        for (const r of rows) {
          const client = table("oauth_clients").find((c) => c.id === r.client_id);
          const existing = byClient.get(r.client_id as string);
          if (!existing || String(r.created_at) > String(existing.authorized_at)) {
            byClient.set(r.client_id as string, {
              client_id: r.client_id,
              client_name: client?.client_name ?? "Application",
              authorized_at: r.created_at,
              expires_at: r.expires_at,
            });
          }
        }
        return { results: [...byClient.values()], success: true, meta: {} };
      }
      return { results: rows, success: true, meta: {} };
    }),
  });

  return {
    prepare: (sql: string) => stmt(sql),
    exec: vi.fn(async () => ({ results: [], success: true, meta: {} })),
    batch: vi.fn(async (stmts: Array<{ run: () => Promise<D1Result> }>) =>
      Promise.all(stmts.map((s) => s.run())),
    ),
    dump: vi.fn(),
    _tables: tables,
  } as unknown as D1Database;
}

const JWT_SECRET = "test-oauth-jwt-secret-with-at-least-32-chars";

export function createOAuthEnv(db: D1Database) {
  return {
    DB: db,
    APP_URL: "https://getengram.app",
    SUPABASE_JWT_SECRET: JWT_SECRET,
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon",
  } as unknown as Parameters<typeof import("../index.js").default.fetch>[1];
}

/** Mint an HS256 Supabase-style JWT for the approve flow. */
export async function signSupabaseJwt(email: string): Promise<string> {
  const enc = new TextEncoder();
  const b64 = (s: string | Uint8Array) => {
    const bytes = typeof s === "string" ? enc.encode(s) : s;
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64(
    JSON.stringify({
      sub: "user-1",
      email,
      role: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64(new Uint8Array(sig))}`;
}

/** PKCE helper: returns a verifier and its S256 challenge. */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = "test-verifier-0123456789-abcdefghijklmnopqrstuvwxyz";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let bin = "";
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  const challenge = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { verifier, challenge };
}
