import { vi } from "vitest";

// Mock D1 result types
interface D1Result {
  results: unknown[];
  success: boolean;
  meta: Record<string, unknown>;
}

// Counter columns that real SQLite defaults to 0 but a hand-rolled INSERT
// leaves undefined. Applied when the mock hands back a usage row so the
// tier gates read numbers, as they do in production.
const COUNTER_DEFAULTS: Record<string, Record<string, number>> = {
  usage: { messages_stored: 0, searches_run: 0, api_requests: 0, chunks_indexed: 0 },
};

// Create a mock D1 database that stores data in memory
export function createMockD1(): D1Database {
  const tables: Record<string, Record<string, unknown>[]> = {};

  function getTable(name: string) {
    if (!tables[name]) tables[name] = [];
    return tables[name];
  }

  const mockStatement = (sql: string, bindings: unknown[] = []) => {
    return {
      bind: (...args: unknown[]) => mockStatement(sql, args),
      run: vi.fn(async (): Promise<D1Result> => {
        // Simple INSERT handler
        const insertMatch = sql.match(/INSERT\s+(?:OR\s+(IGNORE|REPLACE)\s+)?INTO\s+(\w+)/i);
        if (insertMatch) {
          const table = getTable(insertMatch[2]);
          // Extract column names
          const colMatch = sql.match(/\(([^)]+)\)\s+VALUES/i);
          if (colMatch) {
            const cols = colMatch[1].split(",").map((c) => c.trim());
            const row: Record<string, unknown> = {};
            cols.forEach((col, i) => {
              row[col] = bindings[i] ?? null;
            });
            // An explicit conflict target behaves as it does in SQLite: a row
            // that already matches on those columns is not inserted again, and
            // meta.changes reports it (0) the way a claim-style upsert reads
            // it. The DO UPDATE branch is not modelled here; code that depends
            // on it is tested against real SQLite (stripe-webhook-events.d1).
            const target = sql.match(/ON\s+CONFLICT\s*\(([^)]+)\)/i);
            if (target) {
              const keys = target[1].split(",").map((k) => k.trim());
              const clash = table.some((r) => keys.every((k) => r[k] === row[k]));
              if (clash) return { results: [], success: true, meta: { changes: 0 } };
              table.push(row);
              return { results: [], success: true, meta: { changes: 1 } };
            }
            // INSERT OR REPLACE (chunk rows on re-index): the row with the
            // same primary key is replaced, so a re-index of the same window
            // upserts instead of duplicating.
            if (/replace/i.test(insertMatch[1] ?? "") && row.id !== undefined) {
              const dup = table.findIndex((r) => r.id === row.id);
              if (dup !== -1) table.splice(dup, 1);
            }
            table.push(row);
          }
          return { results: [], success: true, meta: {} };
        }
        // Simple UPDATE handler
        if (sql.match(/UPDATE/i)) {
          return { results: [], success: true, meta: {} };
        }
        // Simple DELETE handler
        if (sql.match(/DELETE/i)) {
          const tableMatch = sql.match(/FROM\s+(\w+)/i);
          if (tableMatch) {
            const tableName = tableMatch[1];
            // Simple: clear entries matching first binding as an ID field
            tables[tableName] = (tables[tableName] || []).filter((row) => {
              // Check conversation_id, id, or event_id (stripe_webhook_events)
              return (
                row.conversation_id !== bindings[0] &&
                row.id !== bindings[0] &&
                row.event_id !== bindings[0]
              );
            });
          }
          return { results: [], success: true, meta: {} };
        }
        return { results: [], success: true, meta: {} };
      }),
      first: vi.fn(async () => {
        // Upserts and atomic counters hand their row back via RETURNING and
        // have no FROM clause. The two shapes the tier gates rely on are
        // modelled here — INSERT … ON CONFLICT(keys) … RETURNING *, and
        // UPDATE t SET c = c + ? … WHERE … [AND c + ? <= ?] RETURNING c —
        // so limited tiers run their real gates in tests instead of reading
        // every reservation as "exceeded".
        const upsert = sql.match(
          /INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES[\s\S]*ON\s+CONFLICT\s*\(([^)]+)\)[\s\S]*RETURNING\s+\*/i
        );
        if (upsert) {
          const table = getTable(upsert[1]);
          const cols = upsert[2].split(",").map((c) => c.trim());
          const keys = upsert[3].split(",").map((k) => k.trim());
          const input: Record<string, unknown> = {};
          cols.forEach((col, i) => {
            input[col] = bindings[i] ?? null;
          });
          let row = table.find((r) => keys.every((k) => r[k] === input[k]));
          if (!row) {
            row = { ...(COUNTER_DEFAULTS[upsert[1]] ?? {}), ...input };
            table.push(row);
          }
          return { ...(COUNTER_DEFAULTS[upsert[1]] ?? {}), ...row };
        }
        const counter = sql.match(
          /UPDATE\s+(\w+)\s+SET\s+(\w+)\s*=\s*\2\s*\+\s*\?[\s\S]*?WHERE\s+([\s\S]*?)\s+RETURNING\s+(\w+)/i
        );
        if (counter) {
          const [, tableName, col, where, ret] = counter;
          const table = getTable(tableName);
          // Equality terms bind in order after the delta; a `c + ? <= ?`
          // guard binds (delta, limit) after them, as in the real queries.
          const eqCols = [...where.matchAll(/(\w+)\s*=\s*\?/g)].map((m) => m[1]);
          const guarded = /\w+\s*\+\s*\?\s*<=\s*\?/.test(where);
          const delta = Number(bindings[0]);
          const row = table.find((r) => eqCols.every((c, i) => r[c] === bindings[1 + i]));
          if (!row) return null;
          const current = Number(row[col] ?? 0);
          if (guarded && current + delta > Number(bindings[1 + eqCols.length + 1])) {
            return null;
          }
          row[col] = current + delta;
          return { [ret]: row[col] };
        }

        const tableMatch = sql.match(/FROM\s+(\w+)/i);
        if (!tableMatch) return null;
        const table = getTable(tableMatch[1]);

        // Period row lookup (getUsage) — keyed by org + period, not id.
        if (sql.includes("organization_id = ? AND period = ?") && bindings.length >= 2) {
          const row = table.find(
            (r) => r.organization_id === bindings[0] && r.period === bindings[1]
          );
          return row ? { ...(COUNTER_DEFAULTS[tableMatch[1]] ?? {}), ...row } : null;
        }

        // COUNT(*) query
        if (sql.includes("COUNT(*)")) {
          let rows = [...table];
          if (sql.includes("organization_id = ?") && bindings.length >= 1) {
            rows = rows.filter((r) => r.organization_id === bindings[0]);
          }
          return { count: rows.length };
        }

        // Simple WHERE id = ? AND organization_id = ?
        if (sql.includes("WHERE") && bindings.length >= 1) {
          const row = table.find((r) => {
            if (sql.includes("key_hash") && bindings[0]) {
              return r.key_hash === bindings[0];
            }
            if (bindings.length >= 2) {
              return r.id === bindings[0] && r.organization_id === bindings[1];
            }
            return r.id === bindings[0];
          });
          return row || null;
        }

        // MAX(sequence) query
        if (sql.includes("MAX(sequence)")) {
          const convMsgs = table.filter(
            (r) => r.conversation_id === bindings[0]
          );
          const maxSeq = convMsgs.reduce(
            (max: number | null, r) =>
              r.sequence != null
                ? Math.max(max ?? 0, r.sequence as number)
                : max,
            null
          );
          return { max_seq: maxSeq };
        }

        return table[0] || null;
      }),
      all: vi.fn(async (): Promise<D1Result> => {
        const tableMatch = sql.match(/FROM\s+(\w+)/i);
        if (!tableMatch) return { results: [], success: true, meta: {} };
        const table = getTable(tableMatch[1]);

        let results = [...table];

        // FTS query — will match against chunks_fts which doesn't exist in mock
        if (sql.includes("chunks_fts")) {
          return { results: [], success: true, meta: {} };
        }

        // Filter by id IN (...) — used by getChunksByIds and conversation metadata
        // Must run before generic organization_id filter since org binding is last
        if (sql.includes("id IN (") && !sql.includes("vectorize_id") && !sql.includes("chunk_id")) {
          const hasOrgFilter = sql.includes("organization_id = ?");
          const orgId = hasOrgFilter ? bindings[bindings.length - 1] : null;
          const ids = hasOrgFilter ? bindings.slice(0, -1) : bindings;
          results = results.filter((r) => ids.includes(r.id));
          if (orgId) {
            results = results.filter((r) => r.organization_id === orgId);
          }
          return { results, success: true, meta: {} };
        }

        // Filter by vectorize_id IN (...)
        if (sql.includes("vectorize_id IN")) {
          results = results.filter((r) =>
            bindings.includes(r.vectorize_id)
          );
          return { results, success: true, meta: {} };
        }

        // Filter by organization_id. The queries that scope a conversation
        // first (`WHERE conversation_id = ? AND organization_id = ?` — the
        // sequence-window reads behind message edit/delete) bind the org
        // second, so take the placeholder order from the SQL.
        const orgPos = sql.indexOf("organization_id = ?");
        const convPos = sql.indexOf("conversation_id = ?");
        const convFirst = convPos !== -1 && orgPos !== -1 && convPos < orgPos;
        const orgIdx = convFirst ? 1 : 0;
        if (orgPos !== -1 && bindings[orgIdx]) {
          results = results.filter(
            (r) => r.organization_id === bindings[orgIdx]
          );
        }

        // Filter by seat_id = ? — resolved by placeholder ordinal so it composes
        // with the organization_id filter above (getApiKeysByOrg for a seat member).
        if (sql.includes("seat_id = ?")) {
          const before = sql.slice(0, sql.indexOf("seat_id = ?"));
          const ordinal = (before.match(/\?/g) ?? []).length;
          results = results.filter((r) => r.seat_id === bindings[ordinal]);
        }

        // Filter by conversation_id
        if (convPos !== -1) {
          const convIdx = convFirst ? 0 : orgPos !== -1 ? 1 : 0;
          results = results.filter(
            (r) => r.conversation_id === (bindings[convIdx] ?? bindings[0])
          );
        }

        return { results, success: true, meta: {} };
      }),
    };
  };

  return {
    prepare: (sql: string) => mockStatement(sql),
    exec: vi.fn(async (sql: string) => {
      // Execute raw SQL for setup — parse simple INSERT statements
      const statements = sql.split(";").filter((s) => s.trim());
      for (const stmt of statements) {
        const insertMatch = stmt.match(
          /INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i
        );
        if (insertMatch) {
          const table = getTable(insertMatch[1]);
          const cols = insertMatch[2].split(",").map((c) => c.trim());
          const vals = insertMatch[3].split(",").map((v) => {
            const trimmed = v.trim().replace(/^'|'$/g, "");
            // Coerce unquoted numeric values to numbers
            if (!v.trim().startsWith("'") && /^-?\d+(\.\d+)?$/.test(trimmed)) {
              return Number(trimmed);
            }
            return trimmed;
          });
          const row: Record<string, unknown> = {};
          cols.forEach((col, i) => (row[col] = vals[i]));
          table.push(row);
        }
        // Handle CREATE TABLE — just ignore
      }
      return { results: [], success: true, meta: {} };
    }),
    batch: vi.fn(async (stmts: Array<{ run: () => Promise<D1Result> }>) => {
      const results = [];
      for (const stmt of stmts) {
        results.push(await stmt.run());
      }
      return results;
    }),
    dump: vi.fn(),
  } as unknown as D1Database;
}

export function createMockEnv(db: D1Database) {
  // In-memory R2 mock so content write-then-read round-trips in tests.
  const r2store = new Map<string, string>();
  return {
    // Exposed so tests can assert what is actually left in the bucket,
    // rather than trusting that delete was called.
    __r2store: r2store,
    // Bindings no test exercises, present so the returned object is a
    // complete Env. Without them, callers that spread this and cast to Env
    // (billing.test.ts, seats.test.ts) rely on TypeScript's comparability
    // rule tolerating three missing fields — which it stops doing as soon
    // as the rest of the shape gets closer to the real types.
    SELF: {} as Fetcher,
    DRAINER: {} as DurableObjectNamespace,
    SUPABASE_ANON_KEY: "test-anon-key",
    DB: db,
    CONTENT: {
      put: vi.fn(async (key: string, val: unknown) => {
        r2store.set(key, typeof val === "string" ? val : String(val));
        return {};
      }),
      get: vi.fn(async (key: string) => {
        const v = r2store.get(key);
        return v == null ? null : { text: async () => v };
      }),
      // Real R2 delete accepts a single key OR an array of up to 1000.
      // The mock must too, or batched deletes silently no-op in tests.
      delete: vi.fn(async (key: string | string[]) => {
        for (const k of Array.isArray(key) ? key : [key]) r2store.delete(k);
      }),
      head: vi.fn(async () => null),
      list: vi.fn(async () => ({ objects: [] })),
    } as unknown as R2Bucket,
    AI: {
      run: vi.fn(async () => ({
        data: [[0.1, 0.2, 0.3]], // minimal fake embedding
      })),
    } as unknown as Ai,
    VECTORIZE: {
      query: vi.fn(async () => ({ matches: [] })),
      upsert: vi.fn(async () => ({ count: 0 })),
      deleteByIds: vi.fn(async () => ({ count: 0 })),
      describe: vi.fn(async () => ({})),
      insert: vi.fn(async () => ({ count: 0 })),
      getByIds: vi.fn(async () => []),
    } as unknown as VectorizeIndex,
  };
}
