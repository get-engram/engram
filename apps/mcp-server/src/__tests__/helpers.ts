import { vi } from "vitest";

// Mock D1 result types
interface D1Result {
  results: unknown[];
  success: boolean;
  meta: Record<string, unknown>;
}

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
        const insertMatch = sql.match(/INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+(\w+)/i);
        if (insertMatch) {
          const table = getTable(insertMatch[1]);
          // Extract column names
          const colMatch = sql.match(/\(([^)]+)\)\s+VALUES/i);
          if (colMatch) {
            const cols = colMatch[1].split(",").map((c) => c.trim());
            const row: Record<string, unknown> = {};
            cols.forEach((col, i) => {
              row[col] = bindings[i] ?? null;
            });
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
              // Check conversation_id or id
              return (
                row.conversation_id !== bindings[0] &&
                row.id !== bindings[0]
              );
            });
          }
          return { results: [], success: true, meta: {} };
        }
        return { results: [], success: true, meta: {} };
      }),
      first: vi.fn(async () => {
        const tableMatch = sql.match(/FROM\s+(\w+)/i);
        if (!tableMatch) return null;
        const table = getTable(tableMatch[1]);

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

        // Filter by organization_id
        if (sql.includes("organization_id = ?") && bindings[0]) {
          results = results.filter(
            (r) => r.organization_id === bindings[0]
          );
        }

        // Filter by conversation_id
        if (sql.includes("conversation_id = ?")) {
          const convIdx = sql.includes("organization_id = ?") ? 1 : 0;
          results = results.filter(
            (r) => r.conversation_id === (bindings[convIdx] ?? bindings[0])
          );
        }

        // Filter by vectorize_id IN (...)
        if (sql.includes("vectorize_id IN")) {
          results = results.filter((r) =>
            bindings.includes(r.vectorize_id)
          );
        }

        // Filter by id IN (...) — used by getChunksByIds and conversation metadata
        if (sql.includes("id IN (") && !sql.includes("vectorize_id") && !sql.includes("chunk_id")) {
          // Bindings are the IDs followed possibly by organizationId
          const hasOrgFilter = sql.includes("organization_id = ?");
          const orgId = hasOrgFilter ? bindings[bindings.length - 1] : null;
          const ids = hasOrgFilter ? bindings.slice(0, -1) : bindings;
          results = results.filter((r) => ids.includes(r.id));
          if (orgId) {
            results = results.filter((r) => r.organization_id === orgId);
          }
        }

        // FTS query — will match against chunks_fts which doesn't exist in mock
        if (sql.includes("chunks_fts")) {
          return { results: [], success: true, meta: {} };
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
  return {
    DB: db,
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
