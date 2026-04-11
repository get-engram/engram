import { describe, it, expect, beforeAll } from "vitest";
import { createMockD1, createMockEnv } from "./helpers.js";
import { createConversation, getConversation } from "../services/conversation.js";
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
});
