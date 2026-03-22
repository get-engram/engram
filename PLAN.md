# Engram — Memory as a Service

## Context

Every existing agent memory product (Mem0, Zep, Supermemory, etc.) compresses and summarizes conversations into extracted "memories." None store full, verbatim conversation transcripts. Engram fills this gap — an MCP-native SaaS where every message, tool call, and response is stored without compaction. The conversation IS the knowledge base.

## Tech Stack

- **Compute:** Cloudflare Workers (edge, global, scales to zero, no Docker)
- **Framework:** Hono.js (lightweight, Workers-native)
- **Structured storage:** Cloudflare D1 (SQLite at edge) — full conversation transcripts
- **Vector search:** Cloudflare Vectorize — semantic search over conversation chunks
- **Embeddings:** Workers AI (`@cf/baai/bge-base-en-v1.5`, 768 dimensions, free, runs at edge)
- **MCP transport:** Streamable HTTP via `createMcpHandler` from `@cloudflare/agents`
- **Auth:** API keys (Phase 1), OAuth via WorkOS/Clerk (Phase 3)
- **Monorepo:** pnpm workspaces + Turborepo

## Phase 1 — MVP (what we build now)

MCP server with 6 tools, D1 storage, Vectorize search, API key auth. No dashboard, no REST API.

## Project Structure

```
engram/
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── packages/
│   ├── shared/                        # @engram/shared
│   │   └── src/
│   │       ├── types/                 # Conversation, Message, Org, ApiKey types
│   │       ├── schemas/               # Zod schemas for MCP tool inputs
│   │       ├── utils/
│   │       │   ├── id.ts              # nanoid with prefixes (org_, conv_, msg_, key_, chk_)
│   │       │   ├── chunk.ts           # Sliding-window conversation chunking
│   │       │   └── auth.ts            # SHA-256 key hashing
│   │       └── constants.ts
│   └── db/                            # @engram/db
│       ├── migrations/
│       │   ├── 0001_initial_schema.sql
│       │   └── 0002_add_indexes.sql
│       └── src/queries/               # Typed D1 query helpers
└── apps/
    └── mcp-server/                    # The MCP server Worker
        ├── wrangler.toml
        └── src/
            ├── index.ts               # Hono app + MCP handler at /mcp
            ├── mcp/
            │   ├── server.ts           # Per-request McpServer factory
            │   └── tools/              # 6 tool files
            ├── middleware/auth.ts       # API key validation
            └── services/
                ├── conversation.ts     # CRUD business logic
                ├── embedding.ts        # Workers AI embedding generation
                └── search.ts           # Vectorize query orchestration
```

## Database Schema (D1)

5 tables:

| Table | Purpose |
|---|---|
| `organizations` | Tenants (id, name, timestamps) |
| `api_keys` | SHA-256 hashed keys with prefix, org_id, expiry, revocation |
| `conversations` | id, org_id, title, agent_id, tags (JSON), metadata (JSON), message_count |
| `messages` | id, conv_id, org_id, role, content (verbatim), tool_call_id, tool_name, sequence, metadata |
| `conversation_chunks` | id, conv_id, org_id, chunk_text, start/end sequence, vectorize_id |

Key design decisions:
- `organization_id` denormalized onto messages and chunks (avoids JOINs for tenant isolation)
- `messages.sequence` integer for deterministic ordering (not timestamps)
- `messages.content` stored as-is — no compaction, no summarization
- API keys: only SHA-256 hash stored, shown to user once at creation

## MCP Tools

| Tool | Input | What it does |
|---|---|---|
| `create_conversation` | title?, agent_id?, tags?, metadata? | Creates a conversation record, returns conv_id |
| `append_messages` | conversation_id, messages[] | Stores messages verbatim, chunks + embeds them, updates Vectorize |
| `search` | query, limit?, conversation_id?, tags? | Semantic search via Vectorize, returns matched chunks + surrounding messages |
| `get_conversation` | conversation_id, message_limit?, message_offset? | Returns full conversation with paginated messages |
| `list_conversations` | limit?, offset?, agent_id?, tags?, sort?, order? | List/filter conversations |
| `delete_conversation` | conversation_id | Deletes conversation, messages, chunks, and Vectorize vectors |

## Vector Search Flow

1. **Chunking:** Sliding window of 5 messages, stride of 3 (2-message overlap). Formatted as `[role]: content` per line.
2. **Embedding:** Workers AI `bge-base-en-v1.5`, batched, ~20-80ms latency. Run synchronously in `append_messages`.
3. **Indexing:** Upsert vectors to Vectorize with metadata `{organization_id, conversation_id, start_sequence, end_sequence}`.
4. **Querying:** Embed query text, query Vectorize with org_id filter, fetch chunk text + surrounding messages from D1.

## Auth Flow (Phase 1)

- Key format: `engram_sk_live_` + 32 random chars
- Passed via `Authorization: Bearer engram_sk_live_...` header on MCP HTTP transport
- Validated by hashing and looking up in `api_keys` table
- Returns `organization_id` for tenant scoping
- `last_used_at` updated via `waitUntil` (non-blocking)

## Implementation Steps

1. Scaffold monorepo (pnpm, turbo, tsconfig, gitignore)
2. Create `packages/shared` — types, Zod schemas, utils (id, chunk, auth)
3. Create `packages/db` — D1 migrations
4. Create `apps/mcp-server` — wrangler.toml, Hono app, auth middleware
5. Implement MCP server factory + 6 tools
6. Implement embedding + search services
7. Add seed script (create org + API key for testing)
8. Test locally with `wrangler dev`

## Verification

1. `pnpm install && pnpm build` — monorepo builds without errors
2. `wrangler d1 migrations apply engram-db --local` — migrations apply
3. `wrangler dev` — server starts, `/health` returns 200
4. Connect an MCP client (Claude Desktop or `npx @anthropic-ai/mcp-inspector`) to `http://localhost:8787/mcp` with API key
5. Call `create_conversation` → get back a conversation_id
6. Call `append_messages` with test messages → messages stored, chunks embedded
7. Call `search` with a query → returns relevant results with scores
8. Call `get_conversation` → returns full conversation with all messages verbatim

## Scale Considerations

- **D1:** 10GB max on paid plan. Sufficient for early traction. Can shard later.
- **Vectorize:** 5M vectors max. ~150K conversations worth. Can partition by org/time.
- **Embeddings:** Synchronous in MVP. Move to Cloudflare Queues if latency becomes an issue.

## Future Phases

- **Phase 2:** REST API, API key management endpoints, R2 for exports, rate limiting
- **Phase 3:** Dashboard (React on CF Pages), OAuth, team management, analytics
