// Free-tier memory window (engram#252): archived — never deleted — outside a
// rolling retention window; upgrading unlocks instantly.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { createMockD1, createMockEnv } from "./helpers.js";
import { searchConversations } from "../services/search.js";
import { retentionCutoff } from "../services/tier.js";
import { retentionNotice } from "../mcp/usage-messaging.js";
import { RETENTION_ENFORCEMENT_DATE } from "@getengram/shared";

const DAY = 86_400_000;
const AFTER_ENFORCEMENT = Date.parse(RETENTION_ENFORCEMENT_DATE) + DAY;
const BEFORE_ENFORCEMENT = Date.parse(RETENTION_ENFORCEMENT_DATE) - DAY;

describe("retentionCutoff (#252)", () => {
  it("is null for permanent-retention tiers at any time", () => {
    expect(retentionCutoff("pro", AFTER_ENFORCEMENT)).toBeNull();
    expect(retentionCutoff("team", AFTER_ENFORCEMENT)).toBeNull();
    expect(retentionCutoff("enterprise", AFTER_ENFORCEMENT)).toBeNull();
  });

  it("is null for free before the announced enforcement date (grace period)", () => {
    expect(retentionCutoff("free", BEFORE_ENFORCEMENT)).toBeNull();
  });

  it("is the window start for free after enforcement", () => {
    const cutoff = retentionCutoff("free", AFTER_ENFORCEMENT);
    expect(cutoff).not.toBeNull();
    const ageDays = (AFTER_ENFORCEMENT - Date.parse(cutoff!)) / DAY;
    expect(ageDays).toBeCloseTo(30, 5);
  });
});

describe("search respects the memory window (#252)", () => {
  const organizationId = "org_retention";
  let env: ReturnType<typeof createMockEnv>;

  const now = Date.now();
  const fresh = new Date(now - 1 * DAY).toISOString();
  const stale = new Date(now - 60 * DAY).toISOString();
  const cutoff = new Date(now - 30 * DAY).toISOString();

  beforeAll(() => {
    const db = createMockD1();
    const insertChunk =
      "INSERT INTO conversation_chunks (id, conversation_id, organization_id, chunk_text, start_sequence, end_sequence, vectorize_id, created_at) VALUES (?,?,?,?,?,?,?,?)";
    db.prepare(insertChunk)
      .bind("chk_new", "conv_new", organizationId, "[user]: recent plans", 1, 2, "vec_new", fresh)
      .run();
    db.prepare(insertChunk)
      .bind("chk_old", "conv_old", organizationId, "[user]: ancient plans", 1, 2, "vec_old", stale)
      .run();

    const insertConv =
      "INSERT INTO conversations (id, organization_id, title, tags, updated_at) VALUES (?,?,?,?,?)";
    db.prepare(insertConv)
      .bind("conv_new", organizationId, "Recent", "[]", fresh)
      .run();
    db.prepare(insertConv)
      .bind("conv_old", organizationId, "Ancient", "[]", stale)
      .run();

    env = createMockEnv(db);
    (env.VECTORIZE as unknown as Record<string, unknown>).query = vi.fn(async () => ({
      count: 2,
      matches: [
        { id: "vec_new", score: 0.9 },
        { id: "vec_old", score: 0.9 },
      ],
    }));
  });

  it("hides archived conversations and reports the withheld count", async () => {
    const outcome = await searchConversations(
      env as unknown as Parameters<typeof searchConversations>[0],
      organizationId,
      "plans",
      10,
      undefined,
      undefined,
      undefined,
      0, // minScore off — isolate the retention filter
      true,
      undefined,
      cutoff,
    );
    expect(outcome.results.map((r) => r.conversation_id)).toEqual(["conv_new"]);
    expect(outcome.archived_conversations).toBe(1);
  });

  it("returns everything when there is no cutoff (paid tiers / grace period)", async () => {
    const outcome = await searchConversations(
      env as unknown as Parameters<typeof searchConversations>[0],
      organizationId,
      "plans",
      10,
      undefined,
      undefined,
      undefined,
      0,
      true,
      undefined,
      null,
    );
    expect(outcome.results.length).toBe(2);
    expect(outcome.archived_conversations).toBe(0);
  });
});

describe("retentionNotice copy (#252)", () => {
  it("says archived + nothing deleted, and routes OAuth users to the dashboard", () => {
    const msg = retentionNotice({ archivedCount: 3, retentionDays: 30, isOAuth: true });
    expect(msg).toContain("3 older conversations");
    expect(msg).toContain("archived");
    expect(msg).toContain("Nothing is deleted");
    expect(msg).toContain("dashboard");
  });

  it("routes API-key users to pricing and handles the singular case", () => {
    const msg = retentionNotice({ archivedCount: 1, retentionDays: 30, isOAuth: false });
    expect(msg).toContain("1 older conversation matched");
    expect(msg).toContain("pricing");
  });
});
