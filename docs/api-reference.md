# API Reference

Engram exposes 6 tools via the Model Context Protocol (MCP). All tools are accessed through the `/mcp` endpoint using Streamable HTTP transport.

All requests require an `Authorization: Bearer engram_sk_live_...` header.

---

## create_conversation

Create a new conversation to store messages in.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `title` | string | No | Title for the conversation |
| `agent_id` | string | No | Identifier for the agent that owns this conversation |
| `tags` | string[] | No | Tags for filtering and organization |
| `metadata` | object | No | Arbitrary key-value metadata |

### Response

```json
{
  "conversation_id": "conv_V1StGXR8_Z5jdHi6B-myT"
}
```

### Example

```
create_conversation
  title: "Weekly standup — March 23"
  agent_id: "support-bot-v2"
  tags: ["standup", "engineering"]
  metadata: { "team": "platform" }
```

---

## append_messages

Append messages to a conversation. Messages are stored verbatim and automatically chunked and embedded for semantic search.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `conversation_id` | string | Yes | The conversation to append to |
| `messages` | MessageInput[] | Yes | One or more messages to append (min 1) |

**MessageInput:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `role` | string | Yes | One of: `user`, `assistant`, `system`, `tool` |
| `content` | string | Yes | The message content (stored verbatim) |
| `tool_call_id` | string | No | ID of the tool call this message responds to |
| `tool_name` | string | No | Name of the tool that was called |
| `metadata` | object | No | Arbitrary key-value metadata |

### Response

```json
{
  "appended": 2,
  "message_ids": [
    "msg_V1StGXR8_Z5jdHi6B-myT",
    "msg_K2RtHYS9_A6keFj7C-nzU"
  ]
}
```

### Example

```
append_messages
  conversation_id: "conv_V1StGXR8_Z5jdHi6B-myT"
  messages:
    - role: "user"
      content: "Can you look up the customer's billing history?"
    - role: "assistant"
      content: "I'll check that now."
    - role: "tool"
      content: '{"invoices": [{"id": "inv_123", "amount": 99.00}]}'
      tool_name: "lookup_billing"
      tool_call_id: "call_abc"
    - role: "assistant"
      content: "They have one invoice for $99.00."
```

### What happens on append

1. Messages are inserted into the database with sequential ordering
2. New messages are grouped into overlapping chunks (window of 5 messages, stride of 3)
3. Each chunk is embedded using `bge-base-en-v1.5` (768 dimensions)
4. Vectors are upserted to the search index with conversation and organization metadata

---

## search

Semantic search across all stored conversations. Returns matching chunk snippets with relevance scores. Each result contains the `chunk_text` window that Vectorize matched on, clipped to `snippet_chars` characters — call `get_conversation` with the returned `start_sequence` / `end_sequence` if you need the full structured messages.

### Parameters

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `query` | string | Yes | — | Natural language search query |
| `limit` | integer | No | 5 | Max results (1–50) |
| `conversation_id` | string | No | — | Limit search to a specific conversation |
| `tags` | string[] | No | — | Filter by conversation tags |
| `snippet_chars` | integer | No | 1500 | Max characters of `chunk_text` per result (max 5000). Responses over the cap are suffixed with `...[truncated]`. |

### Response

```json
{
  "results": [
    {
      "chunk_id": "chk_V1StGXR8_Z5jdHi6B-myT",
      "conversation_id": "conv_abc123",
      "chunk_text": "[user]: Can you look up the billing?\n[assistant]: I'll check that now.\n...",
      "score": 0.89,
      "start_sequence": 1,
      "end_sequence": 5
    }
  ],
  "total": 1
}
```

### Example

```
search
  query: "customer billing lookup"
  limit: 5
```

Results are ranked by cosine similarity. Each result includes the matching chunk text and the full original messages from that section of the conversation.

---

## get_conversation

Retrieve a conversation with its full verbatim messages. Supports pagination for long conversations.

### Parameters

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `conversation_id` | string | Yes | — | The conversation to retrieve |
| `message_limit` | integer | No | 100 | Max messages to return (1–500) |
| `message_offset` | integer | No | 0 | Offset for pagination |

### Response

```json
{
  "conversation": {
    "id": "conv_V1StGXR8_Z5jdHi6B-myT",
    "title": "Weekly standup — March 23",
    "agent_id": "support-bot-v2",
    "tags": ["standup", "engineering"],
    "metadata": { "team": "platform" },
    "message_count": 42,
    "created_at": "2026-03-23T10:00:00Z",
    "updated_at": "2026-03-23T10:30:00Z"
  },
  "messages": [
    {
      "id": "msg_xyz",
      "role": "user",
      "content": "Let's start with blockers...",
      "sequence": 1,
      "created_at": "2026-03-23T10:00:01Z"
    }
  ]
}
```

### Example

```
get_conversation
  conversation_id: "conv_V1StGXR8_Z5jdHi6B-myT"
  message_limit: 50
  message_offset: 0
```

---

## list_conversations

List conversations with filtering and sorting options.

### Parameters

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `limit` | integer | No | 20 | Max conversations to return (1–100) |
| `offset` | integer | No | 0 | Offset for pagination |
| `agent_id` | string | No | — | Filter by agent ID |
| `tags` | string[] | No | — | Filter by tags |
| `sort` | string | No | `updated_at` | Sort by: `created_at`, `updated_at`, `message_count` |
| `order` | string | No | `desc` | Sort order: `asc` or `desc` |

### Response

```json
{
  "conversations": [
    {
      "id": "conv_V1StGXR8_Z5jdHi6B-myT",
      "title": "Weekly standup — March 23",
      "agent_id": "support-bot-v2",
      "tags": ["standup"],
      "message_count": 42,
      "updated_at": "2026-03-23T10:30:00Z"
    }
  ],
  "total": 1
}
```

### Example

```
list_conversations
  agent_id: "support-bot-v2"
  tags: ["engineering"]
  sort: "message_count"
  order: "desc"
  limit: 10
```

---

## delete_conversation

Permanently delete a conversation and all its messages, chunks, and vector embeddings.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `conversation_id` | string | Yes | The conversation to delete |

### Response

```json
{
  "deleted": true
}
```

Returns an error if the conversation is not found or doesn't belong to your organization.

---

## Error Responses

When a tool encounters an error, it returns:

```json
{
  "error": "Conversation not found"
}
```

Common errors:

| Error | Cause |
|-------|-------|
| `Conversation not found` | Invalid conversation_id or doesn't belong to your organization |
| `401 Unauthorized` | Missing or invalid API key |
| `403 Forbidden` | API key expired or revoked |
