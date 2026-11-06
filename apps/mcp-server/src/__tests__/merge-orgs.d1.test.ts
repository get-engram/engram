import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { Miniflare } from "miniflare";
import {
  getNamedSecret,
  getVaultEntriesByConversation,
  insertConversation,
  insertVaultEntries,
  listConversations,
  listMessageRevisions,
  searchChunksFts,
  upsertNamedSecret,
} from "@getengram/db";
import { appendMessages, updateMessage } from "../services/conversation.js";
import { mergeOrgs } from "../routes/merge-orgs.js";
import { admin } from "../routes/admin.js";
import { purgeDeletedOrganizations } from "../cron/purge-deleted.js";
import { applyAllMigrations } from "./miniflare.js";
import type { Env } from "../types.js";

/**
 * engram#562: merging two accounts, then purging the old one, loses nothing.
 *
 * The merge repoints rows from the source organization to the target; the
 * source is then soft-deleted, and the purge deletes everything still filed
 * under its id. So every row the merge forgets is not orphaned but erased.
 * Before #562 it forgot the tag index (merged conversations dropped out of
 * every tag filter), edit history and vault entries, and named secrets.
 *
 * Real SQLite and R2 (Miniflare), the real routes, and the real purge — the
 * end state is checked through the same reads the product uses.
 */

describe("org merge then purge (engram#562), against real SQLite and R2", () => {
  let mf: Miniflare;
  let db: D1Database;
  let chunks: R2Bucket;
  let content: R2Bucket;
  const vectors = new Map<string, { id: string; values: number[]; metadata?: Record<string, unknown> }>();

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "merge-orgs" },
      r2Buckets: { CHUNKS: "chunks", CONTENT: "content" },
    });
    db = await mf.getD1Database("DB");
    chunks = (await mf.getR2Bucket("CHUNKS")) as unknown as R2Bucket;
    content = (await mf.getR2Bucket("CONTENT")) as unknown as R2Bucket;
    await applyAllMigrations(db);
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  function makeEnv(): Env {
    return {
      DB: db,
      CHUNKS: chunks,
      CONTENT: content,
      AI: {
        async run(_model: string, input: { text: string[] }) {
          return { data: input.text.map(() => Array(768).fill(0.01)) };
        },
      },
      VECTORIZE: {
        async upsert(vs: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>) {
          for (const v of vs) vectors.set(v.id, v);
          return { mutationId: "m" };
        },
        async deleteByIds(ids: string[]) {
          for (const id of ids) vectors.delete(id);
          return { mutationId: "m" };
        },
        async query() {
          return { matches: [], count: 0 };
        },
        async getByIds(ids: string[]) {
          return ids.map((id) => vectors.get(id)).filter(Boolean);
        },
      },
    } as unknown as Env;
  }

  async function addOrg(id: string, email: string | null = null) {
    await db.prepare("INSERT INTO organizations (id, name, email) VALUES (?, ?, ?)").bind(id, id, email).run();
  }

  async function count(sql: string, ...params: unknown[]): Promise<number> {
    const row = await db.prepare(sql).bind(...params).first<{ n: number }>();
    return row?.n ?? 0;
  }

  function app() {
    const a = new Hono<{ Bindings: Env }>();
    a.route("/admin", mergeOrgs);
    a.route("/admin", admin);
    return a;
  }

  function request(path: string, body?: unknown): Promise<Response> {
    return Promise.resolve(
      app().request(
        path,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        makeEnv(),
      ),
    );
  }

  async function post<T>(path: string, body?: unknown): Promise<T> {
    const res = await request(path, body);
    expect(res.status).toBe(200);
    return (await res.json()) as T;
  }

  type MergeResponse = {
    moved: Record<string, number>;
    failures: unknown[];
    remaining: number;
    done: boolean;
    left_on_source: Record<string, number>;
    source_empty: boolean;
    note?: string;
  };

  const nothingLeft = {
    conversations: 0,
    messages: 0,
    chunks: 0,
    tags: 0,
    revisions: 0,
    vault: 0,
    named_secrets: 0,
  };

  it("moves every row a conversation owns, and the old account's purge then erases nothing of it", async () => {
    const env = makeEnv();
    await addOrg("org_src", "src@example.test");
    await addOrg("org_dst", "dst@example.test");

    // A tagged conversation with messages, one edited (so it has history),
    // and a vault entry; named secrets on both accounts, one name on both.
    await insertConversation(db, "conv_m", "org_src", "merge me", null, ["alpha", "beta"], {});
    const saved = await appendMessages(env, "org_src", "conv_m", [
      { role: "user", content: "curlew one about the estuary" },
      { role: "assistant", content: "curlew two about the estuary" },
      { role: "user", content: "curlew three about the estuary" },
      { role: "assistant", content: "curlew four about the estuary" },
    ]);
    await updateMessage(env, "org_src", "conv_m", saved[0].id, "curlew one, reworded");
    await insertVaultEntries(db, [
      {
        id: "vlt_m1",
        organizationId: "org_src",
        conversationId: "conv_m",
        messageId: saved[1].id,
        secretType: "api_key",
        encryptedValue: "ciphertext-m1",
        iv: "iv-m1",
        expiresAt: null,
      },
    ]);
    const secret = (id: string, org: string, name: string, value: string) =>
      upsertNamedSecret(db, { id, organizationId: org, name, encryptedValue: value, iv: "iv", secretType: "token" });
    await secret("ns_1", "org_src", "ONLY_ON_SOURCE", "src-only");
    await secret("ns_2", "org_src", "ON_BOTH", "src-both");
    await secret("ns_3", "org_dst", "ON_BOTH", "dst-both");

    const chunkCount = await count("SELECT COUNT(*) AS n FROM conversation_chunks WHERE conversation_id = 'conv_m'");
    expect(chunkCount).toBeGreaterThan(0);
    const revisions = (await listMessageRevisions(db, saved[0].id, "org_src")).results;
    expect(revisions.length).toBe(1);

    const emails = { from_email: "src@example.test", to_email: "dst@example.test" };

    // The dry run counts everything on the source and changes nothing.
    const dry = await post<{ from: Record<string, unknown> }>("/admin/merge-orgs?dry_run=1", emails);
    expect(dry.from).toMatchObject({
      id: "org_src",
      conversations: 1,
      messages: 4,
      chunks: chunkCount,
      tags: 2,
      revisions: 1,
      vault: 1,
      named_secrets: 2,
      pending: 1,
      private_to_seats: 0,
    });
    expect(await count("SELECT COUNT(*) AS n FROM conversations WHERE organization_id = 'org_src'")).toBe(1);

    // The merge moves it all, except the secret whose name the target has.
    const first = await post<MergeResponse>("/admin/merge-orgs", emails);
    expect(first.failures).toEqual([]);
    expect(first.moved).toEqual({
      conversations: 1,
      messages: 4,
      chunks: chunkCount,
      vectors: chunkCount,
      tags: 2,
      revisions: 1,
      vault: 1,
      named_secrets: 1,
    });
    expect(first.done).toBe(true);
    expect(first.left_on_source).toEqual({ ...nothingLeft, named_secrets: 1 });
    expect(first.source_empty).toBe(false);
    expect(first.note).toMatch(/named secrets/);

    // Running it again is a no-op, and still refuses to call the source empty.
    const again = await post<MergeResponse>("/admin/merge-orgs", emails);
    expect(Object.values(again.moved).every((n) => n === 0)).toBe(true);
    expect(again.source_empty).toBe(false);

    // The target's own value was never overwritten.
    expect(await getNamedSecret(db, "org_dst", "ON_BOTH")).toMatchObject({ encrypted_value: "dst-both" });

    // Once the duplicate is resolved (here: the user keeps the target's
    // value), the source reports empty, and only then is it deleted.
    await db.prepare("DELETE FROM named_secrets WHERE organization_id = 'org_src' AND name = 'ON_BOTH'").run();
    const last = await post<MergeResponse>("/admin/merge-orgs", emails);
    expect(last.left_on_source).toEqual(nothingLeft);
    expect(last.source_empty).toBe(true);
    expect(last.note).toBeUndefined();

    await db.prepare("UPDATE organizations SET deleted_at = '2020-01-01 00:00:00' WHERE id = 'org_src'").run();
    const failures: Array<{ id: string; error: string }> = [];
    expect(await purgeDeletedOrganizations(env, failures)).toBe(1);
    expect(failures).toEqual([]);
    expect(await count("SELECT COUNT(*) AS n FROM organizations WHERE id = 'org_src'")).toBe(0);

    // Everything is still there for the target, through the product's reads.
    const tagged = await listConversations(db, "org_dst", {
      tags: ["alpha", "beta"],
      limit: 10,
      offset: 0,
      sort: "created_at",
      order: "desc",
    });
    expect(tagged.results.map((r) => (r as { id: string }).id)).toEqual(["conv_m"]);
    expect(
      await count("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = 'conv_m' AND organization_id = 'org_dst'"),
    ).toBe(4);
    for (const m of saved) expect(await content.head(`content/${m.id}`)).not.toBeNull();

    const history = (await listMessageRevisions(db, saved[0].id, "org_dst")).results;
    expect(history.map((r) => r.id)).toEqual(revisions.map((r) => r.id));
    expect(await content.head(`content/${history[0].id}`)).not.toBeNull();

    const vault = (await getVaultEntriesByConversation(db, "conv_m", "org_dst")).results;
    expect(vault).toMatchObject([{ id: "vlt_m1", encrypted_value: "ciphertext-m1", iv: "iv-m1" }]);

    expect(await getNamedSecret(db, "org_dst", "ONLY_ON_SOURCE")).toMatchObject({ encrypted_value: "src-only" });
    expect(await getNamedSecret(db, "org_dst", "ON_BOTH")).toMatchObject({ encrypted_value: "dst-both" });

    expect((await chunks.list({ prefix: "conv_m/" })).objects.length).toBe(chunkCount);
    expect((await searchChunksFts(db, "curlew", "org_dst", 10)).results.length).toBeGreaterThan(0);
  });

  it("the tag reindex rebuilds missing index rows from conversations.tags, under the right org, once", async () => {
    await addOrg("org_tags");
    await addOrg("org_tags2");

    // Index rows lost, as the merge's purge and the early welcome seed left them.
    await insertConversation(db, "conv_lost", "org_tags", "t", null, ["alpha", "beta"], {});
    await insertConversation(db, "conv_lost2", "org_tags2", "t", null, ["alpha"], {});
    await db.prepare("DELETE FROM conversation_tags WHERE conversation_id IN ('conv_lost', 'conv_lost2')").run();
    // Intact: nothing to add.
    await insertConversation(db, "conv_ok", "org_tags", "t", null, ["delta"], {});
    // Written raw, as only a bug or a hand edit could: indexed exactly as
    // insertConversation would (non-empty strings, once), and malformed or
    // non-array JSON read as no tags instead of failing the page.
    const raw = (id: string, tags: string, rowid?: number) =>
      rowid === undefined
        ? db.prepare("INSERT INTO conversations (id, organization_id, tags) VALUES (?, 'org_tags', ?)").bind(id, tags).run()
        : db
            .prepare("INSERT INTO conversations (rowid, id, organization_id, tags) VALUES (?, ?, 'org_tags', ?)")
            .bind(rowid, id, tags)
            .run();
    await raw("conv_notjson", "not json");
    await raw("conv_object", '{"alpha":1}');
    await raw("conv_mixed", '[1, "", null, "gamma", "gamma", {"x":1}, ["y"]]');
    // Far past the first page, so the walk has to page to reach it.
    await raw("conv_far", '["epsilon"]', 1200);

    async function runToEnd() {
      let after = 0;
      let inserted = 0;
      let calls = 0;
      for (;;) {
        const r = await post<{ next_after: number; inserted: number; done: boolean; top: number }>(
          `/admin/reindex-tags?after=${after}&pages=1`,
        );
        calls++;
        inserted += r.inserted;
        if (r.done) {
          expect(r.next_after).toBe(r.top);
          return { inserted, calls };
        }
        expect(r.next_after).toBeGreaterThan(after);
        after = r.next_after;
      }
    }

    const first = await runToEnd();
    expect(first.calls).toBeGreaterThan(1);
    expect(first.inserted).toBe(5); // alpha+beta, alpha (org_tags2), gamma, epsilon

    const rows = await db
      .prepare(
        `SELECT conversation_id, organization_id, tag FROM conversation_tags
          WHERE conversation_id IN ('conv_lost', 'conv_lost2', 'conv_ok', 'conv_notjson', 'conv_object', 'conv_mixed', 'conv_far')
          ORDER BY conversation_id, tag`,
      )
      .all<{ conversation_id: string; organization_id: string; tag: string }>();
    expect(rows.results).toEqual([
      { conversation_id: "conv_far", organization_id: "org_tags", tag: "epsilon" },
      { conversation_id: "conv_lost", organization_id: "org_tags", tag: "alpha" },
      { conversation_id: "conv_lost", organization_id: "org_tags", tag: "beta" },
      { conversation_id: "conv_lost2", organization_id: "org_tags2", tag: "alpha" },
      { conversation_id: "conv_mixed", organization_id: "org_tags", tag: "gamma" },
      { conversation_id: "conv_ok", organization_id: "org_tags", tag: "delta" },
    ]);

    const byTag = async (org: string, tag: string) =>
      (
        await listConversations(db, org, { tags: [tag], limit: 10, offset: 0, sort: "created_at", order: "desc" })
      ).results.map((r) => (r as { id: string }).id);
    expect(await byTag("org_tags", "alpha")).toEqual(["conv_lost"]);
    expect(await byTag("org_tags2", "alpha")).toEqual(["conv_lost2"]);
    expect(await byTag("org_tags", "gamma")).toEqual(["conv_mixed"]);

    // A second full run finds nothing to do.
    expect((await runToEnd()).inserted).toBe(0);
  });

  it("refuses to merge an account whose team members have private conversations, and moves nothing", async () => {
    await addOrg("org_team", "team@example.test");
    await addOrg("org_solo", "solo@example.test");
    // Shared, and the owner's own private one (no seat), would move fine.
    // The member's private one would be unreachable on the target.
    await insertConversation(db, "conv_team_shared", "org_team", "t", null, [], {}, "seat_member", "shared");
    await insertConversation(db, "conv_owner_private", "org_team", "t", null, [], {}, null, "private");
    await insertConversation(db, "conv_member_private", "org_team", "t", null, [], {}, "seat_member", "private");
    const emails = { from_email: "team@example.test", to_email: "solo@example.test" };

    const dry = await post<{ from: Record<string, unknown> }>("/admin/merge-orgs?dry_run=1", emails);
    expect(dry.from).toMatchObject({ conversations: 3, pending: 3, private_to_seats: 1 });

    const res = await request("/admin/merge-orgs", emails);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ private_to_seats: 1 });
    expect(await count("SELECT COUNT(*) AS n FROM conversations WHERE organization_id = 'org_team'")).toBe(3);
    expect(await count("SELECT COUNT(*) AS n FROM conversations WHERE organization_id = 'org_solo'")).toBe(0);
  });
});
