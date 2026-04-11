import { describe, it, expect } from "vitest";
import type {
  Conversation as SharedConversation,
  Message as SharedMessage,
  SearchResult as SharedSearchResult,
  MessageInput as SharedMessageInput,
} from "@getengram/shared";
import type {
  Conversation as SdkConversation,
  Message as SdkMessage,
  SearchResult as SdkSearchResult,
  MessageInput as SdkMessageInput,
} from "@getengram/sdk";

/**
 * SDK ↔ shared type-sync invariants.
 *
 * Shared types are snake_case (they mirror the D1 schema); SDK types are
 * camelCase (idiomatic TS). The SDK's client.ts manually transforms each
 * field. When a new column is added to a shared type, it's easy to
 * forget the matching SDK field + mapper update, and the SDK will
 * silently return `undefined` for that field.
 *
 * These tests pin the field-by-field mapping so that kind of drift
 * fails loudly. They are compile-time + runtime: each SDK<->shared pair
 * has a mapping object with every field enumerated, and TS assignability
 * checks that the object actually covers every field on both sides.
 *
 * To add a new field:
 *   1. Add it to the shared type (snake_case).
 *   2. Add it to the SDK type (camelCase).
 *   3. Add the mapping pair here.
 *   4. Update client.ts mapConversation/mapMessage/mapSearchResult.
 */

// Helper: for a shared type S and SDK type D, enforce that every field
// of both is present in the mapping. If either side is missing a field,
// the object literal is ill-typed and the test fails to compile.
type FieldMap<S, D> = {
  [K in keyof S]: keyof D;
};

// Reverse check — ensures we haven't dropped a field on the SDK side.
type ReverseFieldMap<S, D> = {
  [K in keyof D]: keyof S;
};

describe("SDK ↔ shared type-sync contract", () => {
  describe("Conversation", () => {
    it("has a complete snake→camel field mapping", () => {
      const sharedToSdk: FieldMap<SharedConversation, SdkConversation> = {
        id: "id",
        organization_id: "organizationId",
        title: "title",
        agent_id: "agentId",
        tags: "tags",
        metadata: "metadata",
        message_count: "messageCount",
        created_at: "createdAt",
        updated_at: "updatedAt",
      };

      const sdkToShared: ReverseFieldMap<SharedConversation, SdkConversation> = {
        id: "id",
        organizationId: "organization_id",
        title: "title",
        agentId: "agent_id",
        tags: "tags",
        metadata: "metadata",
        messageCount: "message_count",
        createdAt: "created_at",
        updatedAt: "updated_at",
      };

      // Runtime sanity: both maps have the same number of entries.
      const sharedFields = Object.keys(sharedToSdk).sort();
      const sdkFields = Object.keys(sdkToShared).sort();
      expect(sharedFields).toHaveLength(sdkFields.length);
      // Every value in sharedToSdk should be a key in sdkToShared, and
      // vice versa. That's the actual bidirectional invariant.
      for (const [snake, camel] of Object.entries(sharedToSdk)) {
        expect(sdkToShared[camel as keyof SdkConversation]).toBe(snake);
      }
    });
  });

  describe("Message", () => {
    it("has a complete snake→camel field mapping", () => {
      const sharedToSdk: FieldMap<SharedMessage, SdkMessage> = {
        id: "id",
        conversation_id: "conversationId",
        organization_id: "organizationId",
        role: "role",
        content: "content",
        tool_call_id: "toolCallId",
        tool_name: "toolName",
        sequence: "sequence",
        metadata: "metadata",
        created_at: "createdAt",
      };

      const sdkToShared: ReverseFieldMap<SharedMessage, SdkMessage> = {
        id: "id",
        conversationId: "conversation_id",
        organizationId: "organization_id",
        role: "role",
        content: "content",
        toolCallId: "tool_call_id",
        toolName: "tool_name",
        sequence: "sequence",
        metadata: "metadata",
        createdAt: "created_at",
      };

      const sharedFields = Object.keys(sharedToSdk).sort();
      const sdkFields = Object.keys(sdkToShared).sort();
      expect(sharedFields).toHaveLength(sdkFields.length);
      for (const [snake, camel] of Object.entries(sharedToSdk)) {
        expect(sdkToShared[camel as keyof SdkMessage]).toBe(snake);
      }
    });
  });

  describe("SearchResult", () => {
    it("has a complete snake→camel field mapping", () => {
      // Shared SearchResult uses snake_case:
      //   chunk_id, conversation_id, chunk_text, score,
      //   start_sequence, end_sequence
      const sharedToSdk: FieldMap<SharedSearchResult, SdkSearchResult> = {
        chunk_id: "chunkId",
        conversation_id: "conversationId",
        chunk_text: "chunkText",
        score: "score",
        start_sequence: "startSequence",
        end_sequence: "endSequence",
      };

      const sdkToShared: ReverseFieldMap<SharedSearchResult, SdkSearchResult> = {
        chunkId: "chunk_id",
        conversationId: "conversation_id",
        chunkText: "chunk_text",
        score: "score",
        startSequence: "start_sequence",
        endSequence: "end_sequence",
      };

      const sharedFields = Object.keys(sharedToSdk).sort();
      const sdkFields = Object.keys(sdkToShared).sort();
      expect(sharedFields).toHaveLength(sdkFields.length);
      for (const [snake, camel] of Object.entries(sharedToSdk)) {
        expect(sdkToShared[camel as keyof SdkSearchResult]).toBe(snake);
      }
    });
  });

  describe("MessageInput", () => {
    // MessageInput is the user-facing write shape. The SDK's `store()`
    // method transforms camelCase → snake_case before the tool call, so
    // the mapping here documents what `client.ts` actually emits and what
    // `append-messages.ts` accepts on the wire.
    it("has a complete snake→camel field mapping", () => {
      const sharedToSdk: FieldMap<SharedMessageInput, SdkMessageInput> = {
        role: "role",
        content: "content",
        tool_call_id: "toolCallId",
        tool_name: "toolName",
        metadata: "metadata",
      };

      const sdkToShared: ReverseFieldMap<SharedMessageInput, SdkMessageInput> = {
        role: "role",
        content: "content",
        toolCallId: "tool_call_id",
        toolName: "tool_name",
        metadata: "metadata",
      };

      const sharedFields = Object.keys(sharedToSdk).sort();
      const sdkFields = Object.keys(sdkToShared).sort();
      expect(sharedFields).toHaveLength(sdkFields.length);
      for (const [snake, camel] of Object.entries(sharedToSdk)) {
        expect(sdkToShared[camel as keyof SdkMessageInput]).toBe(snake);
      }
    });
  });
});
