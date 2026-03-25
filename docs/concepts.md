# Concepts

## Verbatim Storage

Engram stores every message exactly as it was sent. No summarization, no extraction, no compression. When you retrieve a conversation, you get back the original text — word for word.

This matters because summaries lose detail. An extracted "memory" that says _"user prefers dark mode"_ throws away the conversation where the user explained _why_ they prefer dark mode, what they tried before, and the three other preferences they mentioned in the same breath.

## Conversations and Messages

A **conversation** is a container for an ordered sequence of messages. It can have:

- A **title** — human-readable name
- An **agent_id** — links the conversation to the agent that created it
- **Tags** — string labels for filtering (e.g., `["support", "billing"]`)
- **Metadata** — arbitrary JSON for your own use

A **message** belongs to a conversation and has:

- A **role** — `user`, `assistant`, `system`, or `tool`
- **Content** — the verbatim text
- A **sequence** number — integer ordering within the conversation
- Optional **tool_call_id** and **tool_name** — for tool-use messages
- Optional **metadata** — arbitrary JSON

Messages are ordered by sequence number, not timestamps. This gives deterministic ordering even if messages are inserted in batches.

## Chunking

When messages are appended, Engram automatically creates **chunks** — overlapping windows of messages used for semantic search.

**How it works:**
- Window size: 5 messages
- Stride: 3 messages
- Overlap: 2 messages between consecutive chunks

For a conversation with 10 messages, you'd get chunks covering:
- Messages 1–5
- Messages 4–8
- Messages 7–10

Each chunk is formatted as:
```
[user]: Can you check the logs?
[assistant]: Sure, looking at the error logs now.
[tool]: {"errors": [{"level": "ERROR", "msg": "connection refused"}]}
[assistant]: I see a connection refused error in the logs.
[user]: That's the one — when did it start?
```

The overlap ensures that no message context is lost at chunk boundaries.

## Embeddings and Vector Search

Each chunk is embedded using the `bge-base-en-v1.5` model (768 dimensions). These embeddings capture the semantic meaning of the conversation fragment.

When you search, your query is embedded with the same model and compared against all stored chunks using cosine similarity. The most relevant chunks are returned along with their original messages.

**Search flow:**
1. Your query text is embedded into a 768-dimensional vector
2. The vector index finds the most similar chunk vectors (filtered by your organization)
3. The matching chunks are fetched from the database
4. The original messages from each chunk's sequence range are loaded
5. Results are returned ranked by similarity score (0–1)

You can scope searches to a specific conversation or filter by tags.

## Organizations and Tenant Isolation

Every API key belongs to an **organization**. All data — conversations, messages, chunks, vectors — is scoped to the organization.

- Queries always filter by `organization_id`
- Vector search includes an organization filter
- There is no way to access another organization's data, even with a valid API key

The `organization_id` is denormalized onto messages and chunks (stored directly, not via JOINs) for both performance and safety.

## Data Model

```
Organization
  └── API Keys (many)
  └── Conversations (many)
        └── Messages (many, ordered by sequence)
        └── Chunks (many, with vector embeddings)
```

All IDs use prefixed nanoids for readability:
- `org_` — organizations
- `conv_` — conversations
- `msg_` — messages
- `key_` — API keys
- `chk_` — chunks
