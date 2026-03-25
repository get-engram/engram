# Architecture

Engram runs entirely on Cloudflare's edge network. Every component — compute, storage, vector search, and embeddings — runs in the same data center, close to the user.

## System Overview

```
MCP Client (Claude, Cursor, custom agent)
    │
    │  Streamable HTTP + API key
    ▼
┌──────────────────────────────────────────┐
│  Cloudflare Worker  (Hono.js)            │
│  ┌──────────────────────────────────┐    │
│  │  Auth Middleware                  │    │
│  │  Validate API key → org context   │    │
│  └──────────────┬───────────────────┘    │
│                 │                         │
│  ┌──────────────▼───────────────────┐    │
│  │  MCP Server (per-request)         │    │
│  │  6 tools registered               │    │
│  └──────────────┬───────────────────┘    │
│                 │                         │
│  ┌──────────────▼───────────────────┐    │
│  │  Services                         │    │
│  │  ├── ConversationService          │    │
│  │  ├── EmbeddingService             │    │
│  │  └── SearchService                │    │
│  └──────────────┬───────────────────┘    │
│                 │                         │
│     ┌───────────┼───────────┐            │
│     ▼           ▼           ▼            │
│  ┌─────┐  ┌──────────┐  ┌────────┐      │
│  │  D1  │  │ Vectorize │  │Workers │      │
│  │(SQLite│  │ (vectors) │  │  AI    │      │
│  └─────┘  └──────────┘  └────────┘      │
└──────────────────────────────────────────┘
```

## Request Lifecycle

### Write Path (append_messages)

1. **Auth** — API key is hashed, looked up in D1, org context extracted
2. **Validate** — Conversation exists and belongs to the org
3. **Sequence** — Get the current max sequence number for the conversation
4. **Insert** — Batch insert messages with sequential ordering (max_seq + 1, +2, ...)
5. **Update count** — Increment the conversation's `message_count`
6. **Chunk** — Sliding window over new messages (window=5, stride=3)
7. **Embed** — Send chunk texts to Workers AI for batch embedding
8. **Store chunks** — Insert chunk records into D1 with vectorize IDs
9. **Index** — Upsert vectors to Vectorize with org/conversation metadata

Steps 1–5 are transactional in D1. Steps 6–9 happen synchronously after (could be moved to a queue in future).

### Read Path (search)

1. **Auth** — Same as above
2. **Embed query** — Convert search text to 768-dimensional vector
3. **Vector query** — Query Vectorize with org_id filter, get top-K matches
4. **Fetch chunks** — Load chunk records from D1 by vectorize IDs
5. **Fetch messages** — For each chunk, load messages in the sequence range
6. **Rank** — Sort results by cosine similarity score (descending)
7. **Return** — Chunk text, score, and original verbatim messages

## Why This Stack

### Cloudflare Workers (not Lambda, not a container)

- **Cold start: 0ms.** Workers are always warm. No container boot, no JIT warmup.
- **Global by default.** Code runs in 300+ data centers. No region selection needed.
- **Scales to zero cost.** No requests = no charges. No idle containers.
- **Co-located with data.** D1, Vectorize, and Workers AI all run in the same network — no cross-region latency.

### D1 (not Postgres, not DynamoDB)

- **SQLite semantics.** Familiar, well-understood, battle-tested query engine.
- **No connection pooling.** D1 uses HTTP bindings — no connection limits, no pgbouncer, no cold connection setup.
- **Automatic replication.** Reads are served from the nearest replica. Writes go to the primary.
- **Schema migrations.** Standard SQL migration files, applied via Wrangler.
- **5GB on free plan, 10GB on paid.** More than enough for early-stage.

### Vectorize (not Pinecone, not Weaviate)

- **Same network as everything else.** No cross-cloud API calls for vector search.
- **Metadata filtering.** Organization and conversation IDs are stored as vector metadata for efficient scoped queries.
- **5M vectors on free tier.** Roughly 150K–200K conversations worth.
- **Managed.** No infrastructure to provision or scale.

### Workers AI (not OpenAI, not Cohere)

- **Free embeddings.** The `bge-base-en-v1.5` model has no per-request cost.
- **Runs at the edge.** Same data center as the Worker — no external API call latency.
- **768 dimensions.** Good balance of quality and index size.

## Monorepo Structure

```
engram/
├── packages/
│   ├── shared/     → Types, schemas, utilities (consumed by all packages)
│   └── db/         → D1 migrations + typed query functions
└── apps/
    └── mcp-server/ → The deployable Cloudflare Worker
```

**Turborepo** handles build orchestration. `pnpm workspaces` handles dependency linking.

Build graph:
```
@engram/shared  ←──  @engram/db  ←──  @engram/mcp-server
```

`shared` has no internal dependencies. `db` depends on `shared` for types. `mcp-server` depends on both.

## MCP Transport

Engram uses **Streamable HTTP** transport — a stateless HTTP-based protocol for MCP. Each request to `/mcp` is an independent HTTP POST containing a JSON-RPC message. No WebSocket connection required.

This is ideal for serverless: each request is handled by a fresh Worker invocation with its own MCP server instance. No connection state to manage, no sticky sessions, no WebSocket lifecycle.

## Tenant Isolation

Multi-tenancy is enforced at every layer:

| Layer | Mechanism |
|-------|-----------|
| **Auth** | API key → organization_id mapping |
| **D1 queries** | Every query includes `WHERE organization_id = ?` |
| **Vectorize** | Vectors include `organization_id` in metadata; queries filter on it |
| **Application** | org_id is set once in auth middleware, threaded through all service calls |

The `organization_id` is **denormalized** onto `messages` and `conversation_chunks` tables. This means tenant-scoped queries never need JOINs — they filter directly on the table being queried.

## Security Model

- **API keys are never stored in plaintext.** Only the SHA-256 hash is persisted.
- **Key prefix stored for identification.** The first 20 characters (e.g., `engram_sk_live_aBcDe`) are stored so keys can be identified in dashboards without exposing the full key.
- **Non-blocking audit.** `last_used_at` is updated via `waitUntil()` so it doesn't add latency to the request.
- **Expiration and revocation.** Keys can have an `expires_at` timestamp and can be revoked by setting `revoked_at`.
