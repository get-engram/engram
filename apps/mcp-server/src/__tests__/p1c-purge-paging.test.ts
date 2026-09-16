import { describe, it, expect } from "vitest";
import {
  getR2MessageIdsByOrganizationPage,
  getVectorizeIdsByOrganizationPage,
  getExpiredOrganizations,
} from "@getengram/db";

// P1c: the GDPR purge streams ids by rowid cursor instead of loading a whole
// (possibly multi-million-row) org into the 128MB isolate, and bounds how many
// expired orgs it processes per run. These pin the cursored SQL + binds.

function captureDb() {
  const calls: { sql: string; args: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind: (...args: unknown[]) => {
          const stmt = { sql, args };
          return { all: async () => (calls.push(stmt), { results: [] }) };
        },
      };
    },
  } as unknown as D1Database;
  return { db, calls };
}

describe("purge paging helpers", () => {
  it("pages R2 message ids by rowid cursor", async () => {
    const { db, calls } = captureDb();
    await getR2MessageIdsByOrganizationPage(db, "org_1", 42, 1000);
    expect(calls[0].sql).toContain("rowid > ?");
    expect(calls[0].sql).toContain("ORDER BY rowid");
    expect(calls[0].sql).toContain("LIMIT ?");
    expect(calls[0].args).toEqual(["org_1", 42, 1000]);
  });

  it("pages vector ids by rowid cursor", async () => {
    const { db, calls } = captureDb();
    await getVectorizeIdsByOrganizationPage(db, "org_1", 7, 500);
    expect(calls[0].sql).toContain("conversation_chunks");
    expect(calls[0].args).toEqual(["org_1", 7, 500]);
  });

  it("bounds the expired-org scan per run", async () => {
    const { db, calls } = captureDb();
    await getExpiredOrganizations(db, 50);
    expect(calls[0].sql).toContain("LIMIT ?");
    expect(calls[0].args).toEqual([50]);
  });
});
