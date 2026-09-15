import { describe, it, expect } from "vitest";
import { deleteOrganizationById } from "@getengram/db";

// The GDPR purge path must not leave personal data behind. Every org-linked
// table either cascades from the organizations delete or is deleted
// explicitly here. email_log is the known exception — it has no FK, so a
// purge that forgets it leaves the user's email address (and which lifecycle
// emails they got) in the database after we've confirmed erasure. Found
// during the 2026-09-15 manual erasure, where it had to be deleted by hand.

function captureDb() {
  const statements: { sql: string; args: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return { bind: (...args: unknown[]) => ({ sql, args }) };
    },
    async batch(stmts: { sql: string; args: unknown[] }[]) {
      statements.push(...stmts);
      return [];
    },
  } as unknown as D1Database;
  return { db, statements };
}

describe("deleteOrganizationById", () => {
  it("deletes email_log rows, which have no FK and never cascade", async () => {
    const { db, statements } = captureDb();
    await deleteOrganizationById(db, "org_x");
    const emailLog = statements.find((s) => s.sql.includes("email_log"));
    expect(emailLog, "purge must clear email_log explicitly").toBeDefined();
    expect(emailLog!.args).toEqual(["org_x"]);
  });

  it("deletes the org row last, so children (and cascades) go first", async () => {
    const { db, statements } = captureDb();
    await deleteOrganizationById(db, "org_x");
    const last = statements[statements.length - 1];
    expect(last.sql).toContain("DELETE FROM organizations WHERE id = ?");
  });

  it("clears the FTS index before the chunks its subquery reads", async () => {
    const { db, statements } = captureDb();
    await deleteOrganizationById(db, "org_x");
    const fts = statements.findIndex((s) => s.sql.includes("chunks_fts_v2"));
    const chunks = statements.findIndex((s) =>
      s.sql.startsWith("DELETE FROM conversation_chunks"),
    );
    expect(fts).toBeGreaterThanOrEqual(0);
    expect(fts).toBeLessThan(chunks);
  });
});
