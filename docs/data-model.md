# Data Model Reference

Complete reference for all database tables, fields, and relationships.

## Entity Relationship

```
┌──────────────┐
│ Organization │
└──────┬───────┘
       │ 1:many
       ├──────────────────┐
       │                  │
┌──────▼───────┐   ┌──────▼──────┐
│   API Key    │   │ Conversation │
└──────────────┘   └──────┬──────┘
                          │ 1:many
                    ┌─────┴─────┐
                    │           │
             ┌──────▼──┐  ┌────▼────────┐
             │ Message  │  │    Chunk    │
             └─────────┘  └─────────────┘
```

---

## Organizations

The top-level tenant. All data is scoped to an organization.

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | Prefixed nanoid: `org_` + 21 chars |
| `name` | TEXT | NOT NULL | Display name for the organization |
| `created_at` | TEXT | NOT NULL, DEFAULT CURRENT_TIMESTAMP | ISO 8601 timestamp |
| `updated_at` | TEXT | NOT NULL, DEFAULT CURRENT_TIMESTAMP | ISO 8601 timestamp |

**Example:**
```json
{
  "id": "org_V1StGXR8_Z5jdHi6B-myT",
  "name": "Acme Corp",
  "created_at": "2026-03-23T10:00:00Z",
  "updated_at": "2026-03-23T10:00:00Z"
}
```

---

## API Keys

Authentication credentials tied to an organization.

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | Prefixed nanoid: `key_` + 21 chars |
| `organization_id` | TEXT | NOT NULL, FOREIGN KEY → organizations(id) | The owning organization |
| `key_hash` | TEXT | NOT NULL, UNIQUE | SHA-256 hash of the raw API key (64 hex chars) |
| `key_prefix` | TEXT | NOT NULL | First 20 characters of the raw key for identification |
| `name` | TEXT | NOT NULL | Human-readable name for the key |
| `expires_at` | TEXT | NULLABLE | ISO 8601 expiration timestamp |
| `revoked_at` | TEXT | NULLABLE | ISO 8601 revocation timestamp |
| `last_used_at` | TEXT | NULLABLE | ISO 8601 timestamp of last use |
| `created_at` | TEXT | NOT NULL, DEFAULT CURRENT_TIMESTAMP | ISO 8601 timestamp |

**Raw key format:** `engram_sk_live_` + 32 random characters (47 chars total)

The raw key is shown once at creation and never stored. Only the SHA-256 hash is persisted.

**Indexes:**
- `idx_api_keys_hash` on `key_hash` — fast lookup during authentication
- `idx_api_keys_org` on `organization_id` — list keys per org

**Example:**
```json
{
  "id": "key_K2RtHYS9_A6keFj7C-nzU",
  "organization_id": "org_V1StGXR8_Z5jdHi6B-myT",
  "key_hash": "a1b2c3d4e5f6...64 hex chars",
  "key_prefix": "engram_sk_live_aBcD",
  "name": "Production key",
  "expires_at": null,
  "revoked_at": null,
  "last_used_at": "2026-03-23T15:42:00Z",
  "created_at": "2026-03-23T10:00:00Z"
}
```

---

## Conversations

A container for an ordered sequence of messages.

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | Prefixed nanoid: `conv_` + 21 chars |
| `organization_id` | TEXT | NOT NULL, FOREIGN KEY → organizations(id) | The owning organization |
| `title` | TEXT | NULLABLE | Human-readable title |
| `agent_id` | TEXT | NULLABLE | Identifier for the agent that created this conversation |
| `tags` | TEXT | NOT NULL, DEFAULT '[]' | JSON array of string tags |
| `metadata` | TEXT | NOT NULL, DEFAULT '{}' | JSON object of arbitrary key-value pairs |
| `message_count` | INTEGER | NOT NULL, DEFAULT 0 | Number of messages in this conversation |
| `created_at` | TEXT | NOT NULL, DEFAULT CURRENT_TIMESTAMP | ISO 8601 timestamp |
| `updated_at` | TEXT | NOT NULL, DEFAULT CURRENT_TIMESTAMP | ISO 8601 timestamp |

**Indexes:**
- `idx_conversations_org` on `organization_id` — list conversations per org
- `idx_conversations_agent` on `agent_id` — filter by agent
- `idx_conversations_updated` on `updated_at` — sort by recency

**Notes:**
- `tags` is stored as a JSON string (e.g., `'["support","billing"]'`) and parsed to `string[]` in application code
- `metadata` is stored as a JSON string and parsed to `Record<string, unknown>` in application code
- `message_count` is incremented atomically on each `append_messages` call

**Example:**
```json
{
  "id": "conv_V1StGXR8_Z5jdHi6B-myT",
  "organization_id": "org_V1StGXR8_Z5jdHi6B-myT",
  "title": "Debugging the auth flow",
  "agent_id": "support-bot-v2",
  "tags": ["engineering", "auth"],
  "metadata": { "sprint": "2026-Q1-W12" },
  "message_count": 24,
  "created_at": "2026-03-23T10:00:00Z",
  "updated_at": "2026-03-23T10:45:00Z"
}
```

---

## Messages

Individual messages within a conversation, stored verbatim.

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | Prefixed nanoid: `msg_` + 21 chars |
| `conversation_id` | TEXT | NOT NULL, FOREIGN KEY → conversations(id) ON DELETE CASCADE | Parent conversation |
| `organization_id` | TEXT | NOT NULL | Denormalized org ID for tenant isolation |
| `role` | TEXT | NOT NULL, CHECK (role IN ('user','assistant','system','tool')) | Message author role |
| `content` | TEXT | NOT NULL | Verbatim message content |
| `tool_call_id` | TEXT | NULLABLE | ID of the tool call this message responds to |
| `tool_name` | TEXT | NULLABLE | Name of the tool that was invoked |
| `sequence` | INTEGER | NOT NULL | Position within the conversation (1, 2, 3, ...) |
| `metadata` | TEXT | NOT NULL, DEFAULT '{}' | JSON object of arbitrary key-value pairs |
| `created_at` | TEXT | NOT NULL, DEFAULT CURRENT_TIMESTAMP | ISO 8601 timestamp |

**Indexes:**
- `idx_messages_conv_seq` on `(conversation_id, sequence)` — ordered retrieval
- `idx_messages_org` on `organization_id` — tenant-scoped queries

**Key design decisions:**
- `organization_id` is **denormalized** — it's redundant with the conversation's org, but avoids JOINs for tenant-scoped queries
- `sequence` is an **integer**, not a timestamp — deterministic ordering regardless of insertion time
- `content` is stored **as-is** — no truncation, no summarization, no HTML encoding
- Cascade delete: when a conversation is deleted, all its messages are automatically removed

**Example:**
```json
{
  "id": "msg_K2RtHYS9_A6keFj7C-nzU",
  "conversation_id": "conv_V1StGXR8_Z5jdHi6B-myT",
  "organization_id": "org_V1StGXR8_Z5jdHi6B-myT",
  "role": "tool",
  "content": "{\"invoices\": [{\"id\": \"inv_123\", \"amount\": 99.00}]}",
  "tool_call_id": "call_abc",
  "tool_name": "lookup_billing",
  "sequence": 3,
  "metadata": {},
  "created_at": "2026-03-23T10:00:03Z"
}
```

---

## Conversation Chunks

Sliding-window text fragments of messages, used for embedding and vector search.

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | Prefixed nanoid: `chk_` + 21 chars |
| `conversation_id` | TEXT | NOT NULL, FOREIGN KEY → conversations(id) ON DELETE CASCADE | Parent conversation |
| `organization_id` | TEXT | NOT NULL | Denormalized org ID for tenant isolation |
| `chunk_text` | TEXT | NOT NULL | Formatted text of the message window |
| `start_sequence` | INTEGER | NOT NULL | First message sequence in this chunk |
| `end_sequence` | INTEGER | NOT NULL | Last message sequence in this chunk |
| `vectorize_id` | TEXT | NOT NULL | Unique ID for the vector in Vectorize |
| `created_at` | TEXT | NOT NULL, DEFAULT CURRENT_TIMESTAMP | ISO 8601 timestamp |

**Indexes:**
- `idx_chunks_conv` on `conversation_id` — list chunks per conversation
- `idx_chunks_org` on `organization_id` — tenant-scoped queries
- `idx_chunks_vectorize` on `vectorize_id` — lookup by vector ID after search

**Chunk text format:**
```
[user]: Can you check the logs?
[assistant]: Sure, looking now.
[tool]: {"errors": [{"level": "ERROR"}]}
[assistant]: I see an error in the logs.
[user]: When did it start?
```

**Chunking algorithm:**
- Window size: 5 messages
- Stride: 3 messages
- Overlap: 2 messages between consecutive chunks
- Messages sorted by sequence before chunking

**Example:**
```json
{
  "id": "chk_M3SuIZT0_B7lfGk8D-ozV",
  "conversation_id": "conv_V1StGXR8_Z5jdHi6B-myT",
  "organization_id": "org_V1StGXR8_Z5jdHi6B-myT",
  "chunk_text": "[user]: Can you check...\n[assistant]: Sure...",
  "start_sequence": 1,
  "end_sequence": 5,
  "vectorize_id": "chk_M3SuIZT0_B7lfGk8D-ozV",
  "created_at": "2026-03-23T10:00:00Z"
}
```

---

## ID Format

All IDs use prefixed nanoids for human readability and type safety.

| Prefix | Entity | Example |
|--------|--------|---------|
| `org_` | Organization | `org_V1StGXR8_Z5jdHi6B-myT` |
| `conv_` | Conversation | `conv_K2RtHYS9_A6keFj7C-nzU` |
| `msg_` | Message | `msg_M3SuIZT0_B7lfGk8D-ozV` |
| `key_` | API Key | `key_N4TvJAU1_C8mgHl9E-paW` |
| `chk_` | Chunk | `chk_O5UwKBV2_D9nhIm0F-qbX` |

IDs are generated using `nanoid` with a default size of 21 characters (plus the prefix). They are URL-safe and contain characters from `A-Za-z0-9_-`.

---

## Vector Metadata

Each vector stored in Vectorize includes metadata for filtering:

| Field | Type | Description |
|-------|------|-------------|
| `organization_id` | string | Org scope for tenant isolation |
| `conversation_id` | string | Source conversation |
| `start_sequence` | number | First message sequence in the chunk |
| `end_sequence` | number | Last message sequence in the chunk |
