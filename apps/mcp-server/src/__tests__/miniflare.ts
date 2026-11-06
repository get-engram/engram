import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/**
 * Shared by the `*.d1.test.ts` files: they run the real queries against real
 * SQLite (Miniflare's D1) with the real migration files applied, for the
 * properties the mock D1 in helpers.ts cannot model — guarded UPDATEs,
 * UNIQUE indexes, RETURNING.
 */
export const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/migrations",
);

/**
 * Apply one migration file, found by the tail of its name (e.g.
 * "_usage_cost_counters.sql"). D1's exec() splits on newlines, so the file is
 * applied one statement at a time; comment lines are dropped first.
 */
export async function applyMigration(db: D1Database, suffix: string): Promise<void> {
  const file = readdirSync(MIGRATIONS_DIR).find((f) => f.endsWith(suffix));
  if (!file) throw new Error(`no migration ending in ${suffix}`);
  const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  for (const stmt of sql.split(";").map((s) => s.trim()).filter(Boolean)) {
    await db.prepare(stmt).run();
  }
}

/**
 * Apply every migration file in order, for tests that drive whole service
 * paths and so touch most tables. Production gained organizations.email from
 * an out-of-band deploy before 0003, which indexes it, so it is added here at
 * the same point.
 */
export async function applyAllMigrations(db: D1Database): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    if (file.startsWith("0003_")) {
      await db.prepare("ALTER TABLE organizations ADD COLUMN email TEXT").run();
    }
    await applyMigration(db, file);
  }
}
