import { describe, it, expect, beforeAll } from "vitest";
import { createMockD1, createMockEnv } from "./helpers.js";
import {
  createConversation,
  getConversation,
  getOrCreateDefaultConversation,
} from "../services/conversation.js";
import { insertOrganization, insertConversation as dbInsertConversation } from "@getengram/db";

describe("Conversation service", () => {
  let db: D1Database;

  beforeAll(async () => {
    db = createMockD1();
    await insertOrganization(db, "org_svc", "Svc Org");
  });

  describe("createConversation", () => {
    it("creates a conversation and returns an id", async () => {
      const id = await createConversation(db, "org_svc", "Test Title", "agent_1", ["tag1"], { foo: "bar" });
      expect(id).toMatch(/^conv_/);
    });

    it("creates with defaults when optional params omitted", async () => {
      const id = await createConversation(db, "org_svc");
      expect(id).toMatch(/^conv_/);
    });
  });

  describe("getConversation", () => {
    it("returns null for non-existent conversation", async () => {
      const result = await getConversation(db, "org_svc", "conv_fake", 100, 0);
      expect(result).toBeNull();
    });

    it("returns conversation with messages", async () => {
      // Create via the service to populate the mock
      const convId = await createConversation(db, "org_svc", "Get Test");
      const result = await getConversation(db, "org_svc", convId, 100, 0);
      expect(result).not.toBeNull();
      expect(result!.conversation.id).toBe(convId);
    });
  });

  describe("getOrCreateDefaultConversation", () => {
    // Tag-aware fake: createMockD1 doesn't parse the json_each tag lookup, so
    // use a minimal store that does.
    function createTaggedD1(): D1Database {
      const convs: Array<Record<string, unknown>> = [];
      const stmt = (sql: string, args: unknown[] = []) => ({
        bind: (...a: unknown[]) => stmt(sql, a),
        run: async () => {
          if (/INSERT\s+INTO\s+conversations/i.test(sql)) {
            convs.push({
              id: args[0],
              organization_id: args[1],
              title: args[2],
              agent_id: args[3],
              tags: args[4],
              metadata: args[5],
            });
          }
          return { results: [], success: true, meta: {} };
        },
        first: async () => {
          if (/FROM\s+conversations/i.test(sql) && /json_each/i.test(sql)) {
            const [org, tag] = args as [string, string];
            const found = convs.find(
              (c) =>
                c.organization_id === org &&
                (JSON.parse((c.tags as string) || "[]") as string[]).includes(tag),
            );
            return found ? { id: found.id } : null;
          }
          return null;
        },
      });
      return {
        prepare: (sql: string) => stmt(sql),
        batch: async (stmts: Array<{ run: () => Promise<unknown> }>) =>
          Promise.all(stmts.map((s) => s.run())),
      } as unknown as D1Database;
    }

    it("creates a default conversation, then reuses it on subsequent calls", async () => {
      const db = createTaggedD1();
      const first = await getOrCreateDefaultConversation(db, "org_d");
      expect(first).toMatch(/^conv_/);
      const second = await getOrCreateDefaultConversation(db, "org_d");
      expect(second).toBe(first);
    });

    it("keeps a separate default per organization", async () => {
      const db = createTaggedD1();
      const a = await getOrCreateDefaultConversation(db, "org_a");
      const b = await getOrCreateDefaultConversation(db, "org_b");
      expect(a).not.toBe(b);
    });
  });
});
