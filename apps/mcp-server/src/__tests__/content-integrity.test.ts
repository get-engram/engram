import { describe, it, expect, vi, afterEach } from "vitest";
import type { Mock } from "vitest";
import { Hono } from "hono";
import { insertConversation, getMessageById } from "@getengram/db";
import { chunkMessages, chunkId } from "@getengram/shared";
import type { Message, MessageRole } from "@getengram/shared";
import { createMockD1, createMockEnv } from "./helpers.js";
import { scanContentIntegrity } from "../services/content-integrity.js";
import { loadContent, storeContent } from "../services/content-store.js";
import { deleteMessage } from "../services/conversation.js";
import { admin } from "../routes/admin.js";
import type { Env } from "../types.js";

/**
 * engram#541: a `messages` row marked r2:* whose object is gone. The read
 * path serves a placeholder and nothing else notices. These tests pin the
 * admin scan that finds such rows and the repair that rebuilds the body
 * from the chunk rows — exactly, or not at all — plus the hardening of the
 * one code path known to be able to produce the orphan (message delete).
 */
const ORG = "org_541";
const PLACEHOLDER = "[Message content unavailable";

type MockEnv = ReturnType<typeof createMockEnv>;
const asEnv = (env: MockEnv) => env as unknown as Env;

/** Zero-padded so id order == sequence order — the order the keyset scan walks. */
const msgId = (convId: string, seq: number) => `msg_${convId}_${String(seq).padStart(3, "0")}`;
const r2Key = (id: string) => `content/${id}`;

/**
 * Seed a conversation the way append + index leave it: every body stored
 * through storeContent (so R2 holds it behind an `r2:*` pointer, raw or
 * gzip by size) and chunk rows built by the real chunker over the same
 * text. `chunks: false` leaves the conversation unindexed.
 */
async function seedConversation(
  env: MockEnv,
  convId: string,
  bodies: Array<[MessageRole, string]>,
  opts: { chunks?: boolean } = {},
): Promise<Message[]> {
  await insertConversation(env.DB, convId, ORG, "Seeded", null, [], {});
  const messages: Message[] = [];
  for (let i = 0; i < bodies.length; i++) {
    const [role, content] = bodies[i];
    const sequence = i + 1;
    const id = msgId(convId, sequence);
    const stored = await storeContent(asEnv(env), id, content);
    await env.DB.prepare(
      "INSERT INTO messages (id, conversation_id, organization_id, role, content, content_encoding, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(id, convId, ORG, role, stored.content, stored.encoding, sequence)
      .run();
    messages.push({
      id,
      conversation_id: convId,
      organization_id: ORG,
      role,
      content,
      tool_call_id: null,
      tool_name: null,
      sequence,
      metadata: {},
      created_at: "2026-11-03T00:00:00.000Z",
    });
  }
  if (opts.chunks !== false) {
    for (const ch of chunkMessages(messages, { onWarn: () => {} })) {
      const id = chunkId(convId, ch.startSequence, ch.endSequence, ch.index);
      await env.DB.prepare(
        "INSERT INTO conversation_chunks (id, conversation_id, organization_id, chunk_text, start_sequence, end_sequence, vectorize_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(id, convId, ORG, ch.text, ch.startSequence, ch.endSequence, id)
        .run();
    }
  }
  return messages;
}

/** The orphan itself: the pointer stays, the object goes. */
function orphan(env: MockEnv, id: string) {
  expect(env.__r2store.has(r2Key(id))).toBe(true);
  env.__r2store.delete(r2Key(id));
}

/** What a reader gets for the message now — through the real read path. */
async function readBack(env: MockEnv, id: string): Promise<string> {
  const row = (await getMessageById(env.DB, id, ORG)) as {
    id: string;
    content: string;
    content_encoding: string | null;
  } | null;
  if (!row) throw new Error(`row ${id} is gone`);
  return loadContent(asEnv(env), row);
}

async function auditRows(env: MockEnv) {
  const res = await env.DB.prepare("SELECT * FROM audit_log").all();
  return (res.results as Array<Record<string, unknown>>).filter(
    (r) => r.action === "admin.message.restore",
  );
}

// Seven messages: windows (1-5) and (4-7). Sequence 3 is covered by one
// window, 4 and 5 by both, 6 and 7 only by the second. Message 3 carries a
// newline and a bracketed colon of its own, message 4 is long enough to be
// gzip-stored — the two shapes the exact-match extraction must survive.
const SAMPLE: Array<[MessageRole, string]> = [
  ["user", "First question about the integrity scan."],
  ["assistant", "Reply one: the pointer says r2:raw but the bucket has nothing."],
  ["user", "Second question, with a newline\ninside it and a [bracket]: colon."],
  [
    "assistant",
    "Reply two is the long one. ".repeat(12) +
      "It runs well past one hundred and twenty-eight bytes and compresses, so it takes the gzip path when stored — the path production bodies of any real size take.",
  ],
  ["user", "Third question."],
  ["assistant", "Reply three."],
  ["user", "Fourth question closes the conversation."],
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scanContentIntegrity (engram#541)", () => {
  it("reports the rows whose R2 object is missing and writes nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = createMockD1();
    const env = createMockEnv(db);
    const conv = "conv_r";
    await seedConversation(env, conv, SAMPLE);
    // A legacy inline row has no object to check and must not be counted.
    await db
      .prepare(
        "INSERT INTO messages (id, conversation_id, organization_id, role, content, content_encoding, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(msgId(conv, 8), conv, ORG, "user", "inline legacy body", null, 8)
      .run();
    orphan(env, msgId(conv, 3));
    orphan(env, msgId(conv, 6));

    const result = await scanContentIntegrity(asEnv(env), { organizationId: ORG });

    expect(result.scanned).toBe(7);
    expect(result.missing.map((m) => m.id)).toEqual([msgId(conv, 3), msgId(conv, 6)]);
    expect(result.missing[0]).toEqual({ id: msgId(conv, 3), conversation_id: conv, sequence: 3 });
    expect(result.repaired).toEqual([]);
    expect(result.unrecoverable).toEqual([]);
    expect(result.deferred).toBe(0);
    expect(result.done).toBe(true);
    // Report-only: the bucket, the rows and the audit log are untouched.
    expect(env.__r2store.has(r2Key(msgId(conv, 3)))).toBe(false);
    expect(await auditRows(env)).toEqual([]);
    expect(await readBack(env, msgId(conv, 3))).toContain(PLACEHOLDER);
  });

  it("rebuilds a message from the one window that covers it, byte for byte", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const db = createMockD1();
    const env = createMockEnv(db);
    const conv = "conv_one";
    await seedConversation(env, conv, SAMPLE);
    const target = msgId(conv, 3);
    orphan(env, target);

    const result = await scanContentIntegrity(asEnv(env), { organizationId: ORG, repair: true });

    expect(result.missing.map((m) => m.id)).toEqual([target]);
    expect(result.unrecoverable).toEqual([]);
    expect(result.repaired).toEqual([
      {
        id: target,
        conversation_id: conv,
        sequence: 3,
        source_chunk: chunkId(conv, 1, 5, 0),
        chars: SAMPLE[2][1].length,
      },
    ]);
    expect(await readBack(env, target)).toBe(SAMPLE[2][1]);
    expect(env.__r2store.has(r2Key(target))).toBe(true);

    const rows = await auditRows(env);
    expect(rows).toHaveLength(1);
    expect(rows[0].resource_id).toBe(target);
    expect(rows[0].api_key_id).toBe("admin");
    // Ids and counts only — the audit log never carries message text.
    expect(JSON.stringify(rows[0])).not.toContain("Second question");
  });

  it("prefers the narrowest covering window and round-trips a gzip-stored body", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const db = createMockD1();
    const env = createMockEnv(db);
    const conv = "conv_two";
    await seedConversation(env, conv, SAMPLE);
    const target = msgId(conv, 4);
    const before = (await getMessageById(db, target, ORG)) as { content_encoding: string };
    expect(before.content_encoding).toBe("r2:gzip+base64");
    orphan(env, target);

    const result = await scanContentIntegrity(asEnv(env), { organizationId: ORG, repair: true });

    // Covered by (1-5) and (4-7); the three-neighbour window wins.
    expect(result.repaired.map((r) => r.source_chunk)).toEqual([chunkId(conv, 4, 7, 0)]);
    expect(await readBack(env, target)).toBe(SAMPLE[3][1]);
    const after = (await getMessageById(db, target, ORG)) as {
      content: string;
      content_encoding: string;
    };
    expect(after.content_encoding).toBe("r2:gzip+base64");
    expect(after.content).toBe("");
  });

  it("reassembles a hard-split oversized message from its pieces", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const db = createMockD1();
    const env = createMockEnv(db);
    const conv = "conv_big";
    // ~5000 chars of non-repeating letters: three 1920-char pieces.
    const big = Array.from({ length: 5000 }, (_, i) => String.fromCharCode(97 + ((i * 7919) % 26))).join("");
    await seedConversation(env, conv, [
      ["user", "Paste the whole log please."],
      ["assistant", big],
      ["user", "Thanks."],
    ]);
    const pieces = (
      await db.prepare("SELECT * FROM conversation_chunks WHERE conversation_id = ? AND organization_id = ?").bind(conv, ORG).all()
    ).results as Array<{ id: string; start_sequence: number; end_sequence: number }>;
    expect(pieces.filter((p) => p.start_sequence === 2 && p.end_sequence === 2)).toHaveLength(3);
    const target = msgId(conv, 2);
    orphan(env, target);

    const result = await scanContentIntegrity(asEnv(env), { organizationId: ORG, repair: true });

    expect(result.repaired).toHaveLength(1);
    expect(result.repaired[0]).toMatchObject({
      id: target,
      source_chunk: chunkId(conv, 2, 2, 0),
      chars: 5000,
    });
    expect(await readBack(env, target)).toBe(big);
  });

  it("repairs in id order so a restored neighbour unlocks the next one", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const db = createMockD1();
    const env = createMockEnv(db);
    const conv = "conv_cascade";
    await seedConversation(env, conv, SAMPLE);
    // 5 is covered by (1-5) and (4-7); 6 only by (4-7), which needs 5.
    orphan(env, msgId(conv, 5));
    orphan(env, msgId(conv, 6));

    const result = await scanContentIntegrity(asEnv(env), { organizationId: ORG, repair: true });

    expect(result.unrecoverable).toEqual([]);
    expect(result.repaired.map((r) => [r.id, r.source_chunk])).toEqual([
      [msgId(conv, 5), chunkId(conv, 1, 5, 0)],
      [msgId(conv, 6), chunkId(conv, 4, 7, 0)],
    ]);
    expect(await readBack(env, msgId(conv, 5))).toBe(SAMPLE[4][1]);
    expect(await readBack(env, msgId(conv, 6))).toBe(SAMPLE[5][1]);
  });

  it("refuses to guess when every covering window also lost a neighbour", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = createMockD1();
    const env = createMockEnv(db);
    const conv = "conv_pair";
    await seedConversation(env, conv, SAMPLE);
    // 6 and 7 share their only window.
    orphan(env, msgId(conv, 6));
    orphan(env, msgId(conv, 7));

    const result = await scanContentIntegrity(asEnv(env), { organizationId: ORG, repair: true });

    expect(result.repaired).toEqual([]);
    expect(result.unrecoverable.map((u) => u.id)).toEqual([msgId(conv, 6), msgId(conv, 7)]);
    for (const u of result.unrecoverable) expect(u.reason).toContain("is missing too");
    expect(env.__r2store.has(r2Key(msgId(conv, 6)))).toBe(false);
    expect(env.__r2store.has(r2Key(msgId(conv, 7)))).toBe(false);
    expect(await auditRows(env)).toEqual([]);
    expect(await readBack(env, msgId(conv, 6))).toContain(PLACEHOLDER);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("serving placeholder"));
  });

  it("reports a message no chunk covers instead of inventing one", async () => {
    const db = createMockD1();
    const env = createMockEnv(db);
    const conv = "conv_unindexed";
    await seedConversation(env, conv, SAMPLE, { chunks: false });
    orphan(env, msgId(conv, 2));

    const result = await scanContentIntegrity(asEnv(env), { organizationId: ORG, repair: true });

    expect(result.repaired).toEqual([]);
    expect(result.unrecoverable).toHaveLength(1);
    expect(result.unrecoverable[0].reason).toContain("no chunk covers this message");
    expect(await auditRows(env)).toEqual([]);
  });

  it("skips a chunk whose text no longer lines up with the neighbours", async () => {
    const db = createMockD1();
    const env = createMockEnv(db);
    const conv = "conv_stale";
    await seedConversation(env, conv, SAMPLE);
    // The only window covering 3 was indexed before message 1 was edited.
    const stale = chunkId(conv, 1, 5, 0);
    await db
      .prepare(
        "INSERT OR REPLACE INTO conversation_chunks (id, conversation_id, organization_id, chunk_text, start_sequence, end_sequence, vectorize_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(stale, conv, ORG, "[user]: an older first question\n[assistant]: and the rest is stale", 1, 5, stale)
      .run();
    orphan(env, msgId(conv, 3));

    const result = await scanContentIntegrity(asEnv(env), { organizationId: ORG, repair: true });

    expect(result.repaired).toEqual([]);
    expect(result.unrecoverable).toHaveLength(1);
    expect(result.unrecoverable[0].reason).toContain("neighbours do not match the chunk text");
    expect(env.__r2store.has(r2Key(msgId(conv, 3)))).toBe(false);
  });

  it("pages on message id and honours the conversation scope", async () => {
    const db = createMockD1();
    const env = createMockEnv(db);
    await seedConversation(env, "conv_a", SAMPLE);
    await seedConversation(env, "conv_b", SAMPLE.slice(0, 3));
    orphan(env, msgId("conv_a", 7));
    orphan(env, msgId("conv_b", 2));

    const p1 = await scanContentIntegrity(asEnv(env), { organizationId: ORG, batch: 3 });
    expect(p1.scanned).toBe(3);
    expect(p1.next_after).toBe(msgId("conv_a", 3));
    expect(p1.done).toBe(false);
    expect(p1.missing).toEqual([]);

    const p2 = await scanContentIntegrity(asEnv(env), { organizationId: ORG, batch: 3, after: p1.next_after });
    expect(p2.scanned).toBe(3);
    expect(p2.next_after).toBe(msgId("conv_a", 6));
    expect(p2.done).toBe(false);

    const p3 = await scanContentIntegrity(asEnv(env), { organizationId: ORG, batch: 3, after: p2.next_after });
    expect(p3.scanned).toBe(3);
    expect(p3.missing.map((m) => m.id)).toEqual([msgId("conv_a", 7), msgId("conv_b", 2)]);
    expect(p3.done).toBe(false);

    const p4 = await scanContentIntegrity(asEnv(env), { organizationId: ORG, batch: 3, after: p3.next_after });
    expect(p4.scanned).toBe(1);
    expect(p4.missing).toEqual([]);
    expect(p4.done).toBe(true);

    const scoped = await scanContentIntegrity(asEnv(env), { organizationId: ORG, conversationId: "conv_b" });
    expect(scoped.scanned).toBe(3);
    expect(scoped.missing.map((m) => m.id)).toEqual([msgId("conv_b", 2)]);
    expect(scoped.done).toBe(true);
  });

  it("caps repairs per call and rewinds the cursor so nothing is skipped", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const db = createMockD1();
    const env = createMockEnv(db);
    const conv = "conv_cap";
    const bodies: Array<[MessageRole, string]> = Array.from({ length: 45 }, (_, i) => [
      i % 2 ? "assistant" : "user",
      `message number ${i + 1}`,
    ]);
    await seedConversation(env, conv, bodies);
    // 42 adjacent orphans: none is repairable, every one is attempted.
    for (let seq = 1; seq <= 42; seq++) orphan(env, msgId(conv, seq));

    const first = await scanContentIntegrity(asEnv(env), { organizationId: ORG, repair: true });
    expect(first.scanned).toBe(40);
    expect(first.missing).toHaveLength(40);
    expect(first.unrecoverable).toHaveLength(40);
    expect(first.deferred).toBe(2);
    expect(first.next_after).toBe(msgId(conv, 40));
    expect(first.done).toBe(false);

    const second = await scanContentIntegrity(asEnv(env), {
      organizationId: ORG,
      repair: true,
      after: first.next_after,
    });
    expect(second.scanned).toBe(5);
    expect(second.missing.map((m) => m.id)).toEqual([msgId(conv, 41), msgId(conv, 42)]);
    expect(second.deferred).toBe(0);
    expect(second.done).toBe(true);
  });
});

describe("POST /admin/content-integrity", () => {
  function setup() {
    const db = createMockD1();
    const env = createMockEnv(db);
    const app = new Hono<{ Bindings: Env }>();
    app.route("/admin", admin);
    return { db, env, app };
  }

  it("repairs on request and answers with ids and counts only", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { env, app } = setup();
    const conv = "conv_route";
    await seedConversation(env, conv, SAMPLE);
    orphan(env, msgId(conv, 3));

    const res = await app.request(
      `/admin/content-integrity?org=${ORG}&repair=1`,
      { method: "POST" },
      asEnv(env),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.scanned).toBe(7);
    expect(body.repaired).toEqual([
      expect.objectContaining({ id: msgId(conv, 3), chars: SAMPLE[2][1].length }),
    ]);
    expect(body.done).toBe(true);
    expect(body.hint).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("Second question");
    expect(await readBack(env, msgId(conv, 3))).toBe(SAMPLE[2][1]);
  });

  it("hands back the next cursor as a ready-to-run hint", async () => {
    const { env, app } = setup();
    const conv = "conv_hint";
    await seedConversation(env, conv, SAMPLE);

    const res = await app.request(
      `/admin/content-integrity?org=${ORG}&batch=3`,
      { method: "POST" },
      asEnv(env),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { done: boolean; next_after: string; hint: string };
    expect(body.done).toBe(false);
    expect(body.next_after).toBe(msgId(conv, 3));
    expect(body.hint).toBe(
      `POST /admin/content-integrity?org=${ORG}&after=${msgId(conv, 3)}&batch=3`,
    );
  });

  it("rejects a call without an org or with a bad batch size", async () => {
    const { env, app } = setup();
    const noOrg = await app.request("/admin/content-integrity", { method: "POST" }, asEnv(env));
    expect(noOrg.status).toBe(400);
    const zero = await app.request(
      `/admin/content-integrity?org=${ORG}&batch=0`,
      { method: "POST" },
      asEnv(env),
    );
    expect(zero.status).toBe(400);
    const huge = await app.request(
      `/admin/content-integrity?org=${ORG}&batch=501`,
      { method: "POST" },
      asEnv(env),
    );
    expect(huge.status).toBe(400);
  });
});

describe("deleteMessage when the D1 row delete fails after the R2 purge (engram#541)", () => {
  it("retries once and finishes the delete", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = createMockD1();
    const env = createMockEnv(db);
    const conv = "conv_del_a";
    await seedConversation(env, conv, SAMPLE);
    const target = msgId(conv, 4);
    (db.batch as unknown as Mock).mockRejectedValueOnce(new Error("D1_ERROR: transient"));

    const ok = await deleteMessage(asEnv(env), ORG, conv, target);

    expect(ok).toBe(true);
    expect(await getMessageById(db, target, ORG)).toBeNull();
    expect(env.__r2store.has(r2Key(target))).toBe(false);
    expect(warns).toHaveBeenCalledWith(expect.stringContaining(`row delete for ${target} succeeded on retry`));
  });

  it("names the dangling row when both attempts fail, and the scan can repair it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = createMockD1();
    const env = createMockEnv(db);
    const conv = "conv_del_b";
    await seedConversation(env, conv, SAMPLE);
    const target = msgId(conv, 4);
    (db.batch as unknown as Mock)
      .mockRejectedValueOnce(new Error("D1_ERROR: still down"))
      .mockRejectedValueOnce(new Error("D1_ERROR: still down"));

    await expect(deleteMessage(asEnv(env), ORG, conv, target)).rejects.toThrow("still down");

    // Exactly the engram#541 state: pointer kept, object gone, and a log
    // line that names the row.
    expect(await getMessageById(db, target, ORG)).not.toBeNull();
    expect(env.__r2store.has(r2Key(target))).toBe(false);
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining(`R2 body purged but row delete failed twice for ${target} in ${conv}`),
    );

    const result = await scanContentIntegrity(asEnv(env), {
      organizationId: ORG,
      conversationId: conv,
      repair: true,
    });
    expect(result.repaired.map((r) => r.id)).toEqual([target]);
    expect(await readBack(env, target)).toBe(SAMPLE[3][1]);
  });
});
