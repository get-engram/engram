# Architecture

A deep dive into how Engram works — from the Cloudflare runtime to the vector math.

## The Big Picture

Engram is a memory service that stores verbatim AI conversations and makes them searchable by meaning. It runs entirely on Cloudflare's edge network — compute, database, vector search, and embeddings all execute in the same data center, within the same internal network.

```
┌─────────────────────────────────────────────────────────────────┐
│                     Cloudflare Edge (300+ cities)                │
│                                                                  │
│  ┌──────────────┐    ┌──────┐    ┌───────────┐    ┌──────────┐ │
│  │    Worker     │◄──►│  D1  │    │ Vectorize  │    │Workers AI│ │
│  │  (your code)  │◄──►│(SQL) │    │ (vectors)  │    │(embeds)  │ │
│  │              │◄──►│      │    │            │    │          │ │
│  └──────┬───────┘    └──────┘    └───────────┘    └──────────┘ │
│         │              ▲               ▲               ▲        │
│         │              │               │               │        │
│         └──────────────┴───────────────┴───────────────┘        │
│                    Internal RPC (not HTTP)                       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
          ▲
          │ HTTPS
          │
    MCP Client
    (Claude, Cursor, your agent)
```

The key thing: **everything inside the box communicates via internal RPC, not public HTTP.** Your Worker doesn't make API calls to D1 or Vectorize — it uses bindings, which are direct function calls routed internally by Cloudflare's runtime. There's no auth, no serialization overhead, no internet round-trip.

---

## How Cloudflare Workers Run Code

Workers are **not containers.** They're **V8 isolates** — the same JavaScript engine that runs in Chrome, but without a browser.

### What this means

```
Traditional server:               Cloudflare Worker:

Boot OS                            ─── doesn't exist
Start runtime (Node, Python)       ─── doesn't exist
Load dependencies                  ─── doesn't exist
Open DB connections                ─── doesn't exist
Wait for request                   Start here ─┐
Handle request                     Handle request │ ~1ms startup
Send response                      Send response  │
                                                ───┘
```

- **No cold start.** V8 isolates spin up in under 1ms (vs. 100ms–5s for containers).
- **No idle cost.** Isolates are destroyed after the request. You don't pay for a server sitting around.
- **Memory isolated.** Each request runs in its own isolate. One request can't read another's memory.
- **Global deployment.** Your code runs in 300+ data centers. When a request arrives at any Cloudflare PoP, a local isolate handles it.

### The execution model

```
Request arrives at Cloudflare PoP (e.g., LAX)
  │
  ├── V8 isolate created (< 1ms)
  ├── Your Worker code runs
  │     ├── env.DB.prepare("SELECT ...").run()     ← RPC to D1
  │     ├── env.AI.run("@cf/baai/bge-base-en-v1.5") ← RPC to Workers AI
  │     └── env.VECTORIZE.query(vector)            ← RPC to Vectorize
  ├── Response sent to client
  └── Isolate destroyed
```

Each request is independent. There's no shared state between requests (no global variables persisting, no connection pools). This is why Engram creates a fresh MCP server instance per request.

---

## How Bindings Work

Bindings are the bridge between your Worker code and Cloudflare's services. They look like regular JavaScript objects, but under the hood they're **RPC stubs** — calling a method on a binding sends an internal message to the service and returns the result.

### In wrangler.toml

```toml
[[d1_databases]]
binding = "DB"                    # → env.DB in your code
database_name = "engram-db"
database_id = "fcf57f81-..."

[[vectorize]]
binding = "VECTORIZE"             # → env.VECTORIZE in your code
index_name = "engram-vectors"

[ai]
binding = "AI"                    # → env.AI in your code
```

### In your code

```typescript
export default {
  async fetch(request: Request, env: Env) {
    // These look like local function calls, but they're RPC
    const result = await env.DB.prepare("SELECT * FROM conversations").all();
    const embedding = await env.AI.run(model, { text: ["hello"] });
    const matches = await env.VECTORIZE.query(embedding, { topK: 10 });
  }
}
```

### What happens behind the scenes

```
env.DB.prepare("SELECT ...").run()
  │
  ├── Worker runtime serializes the SQL + bound params
  ├── Sends internal RPC to D1 service (same data center)
  ├── D1 executes SQL against SQLite
  ├── Result serialized back
  └── Returned to your code as a JavaScript object

Total latency: typically 1-5ms
```

This is fundamentally different from making an HTTP request to a database API. There's no DNS lookup, no TLS handshake, no HTTP parsing. It's a direct internal message.

---

## How D1 Works

D1 is **SQLite running as a service on Cloudflare's network.** It's not Postgres. It's not MySQL. It's actual SQLite — the same embedded database that runs on your phone — but managed by Cloudflare with automatic replication.

### The architecture

```
                    ┌───────────────┐
                    │  Write Primary │ (one location)
                    │    SQLite      │
                    └───────┬───────┘
                            │ replication
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
        ┌──────────┐  ┌──────────┐  ┌──────────┐
        │  Replica  │  │  Replica  │  │  Replica  │
        │   (LAX)   │  │   (CDG)   │  │   (NRT)   │
        └──────────┘  └──────────┘  └──────────┘
              ▲             ▲             ▲
              │             │             │
          Worker in     Worker in     Worker in
          Los Angeles   Paris         Tokyo
```

- **Reads** go to the nearest replica. Fast everywhere.
- **Writes** go to the primary (one region). Slightly higher latency for distant users, but consistent.
- **No connection pooling.** Each D1 call is a self-contained RPC. No "too many connections" errors, no pgbouncer, no connection timeouts.

### How Engram uses D1

Six tables, all scoped by `organization_id`:

```sql
organizations         ── Tenants
  └── api_keys        ── Auth credentials (SHA-256 hashed)
  └── conversations   ── Containers for messages
        └── messages           ── Verbatim content, ordered by sequence
        └── conversation_chunks ── Text windows for embedding
        └── secrets_vault      ── Encrypted secret blobs (zero-knowledge)
```

Every query includes `WHERE organization_id = ?`. The org_id is **denormalized** — it's stored directly on messages and chunks, not just on the parent conversation. This means tenant-scoped queries never need JOINs:

```sql
-- Fast: direct filter on the messages table
SELECT * FROM messages
WHERE conversation_id = ? AND organization_id = ?
ORDER BY sequence

-- Not this: would require joining conversations to get org_id
SELECT m.* FROM messages m
JOIN conversations c ON m.conversation_id = c.id
WHERE c.organization_id = ?
```

### Migrations

Schema changes are standard SQL files in `packages/db/migrations/`:

```
0001_initial_schema.sql  ── 5 tables with foreign keys + cascading deletes
0002_add_indexes.sql     ── 7 indexes for query performance
...
0009_secrets_vault.sql   ── Zero-knowledge secrets vault table
```

Applied via: `wrangler d1 migrations apply engram-db --remote`

---

## How Vectorize Works

Vectorize is a **vector database** — it stores arrays of numbers (vectors) and finds the most similar ones to a query vector. It's how Engram does semantic search.

### What is a vector?

A vector is a list of numbers that represents the *meaning* of text. The embedding model converts text into a point in 768-dimensional space. Texts with similar meaning end up as nearby points.

```
"How do I deploy a Worker?"  →  [0.12, -0.45, 0.78, 0.03, ..., 0.91]  (768 numbers)
"Deploying to Cloudflare"    →  [0.11, -0.44, 0.77, 0.04, ..., 0.90]  (nearby!)
"What's for lunch?"          →  [0.89, 0.23, -0.56, 0.67, ..., -0.12]  (far away)
```

### How it stores and searches

```
Upsert (write):
  Your Worker sends: { id: "chk_abc", values: [0.12, -0.45, ...], metadata: {org_id, conv_id} }
  Vectorize stores it in an optimized index structure (HNSW graph)

Query (read):
  Your Worker sends: query vector [0.11, -0.44, ...], topK: 10, filter: {org_id: "org_xyz"}
  Vectorize:
    1. Filters by metadata (org_id = "org_xyz")
    2. Finds the 10 nearest vectors using approximate nearest neighbor (ANN) search
    3. Returns: [{ id: "chk_abc", score: 0.95 }, { id: "chk_def", score: 0.82 }, ...]
```

### Cosine similarity

The "score" is **cosine similarity** — a measure of how similar two vectors are:

- **1.0** = identical meaning
- **0.7–0.9** = very similar
- **0.5–0.7** = somewhat related
- **< 0.5** = probably unrelated

Engram returns results sorted by score, highest first.

### Metadata indexes

Vectorize can filter vectors by metadata *before* doing similarity search. But metadata fields must be **indexed** first — without an index, the filter is ignored.

Engram creates two metadata indexes:

```
organization_id (string)  ── tenant isolation
conversation_id (string)  ── scope search to one conversation
```

These were created via:
```bash
wrangler vectorize create-metadata-index engram-vectors --property-name=organization_id --type=string
wrangler vectorize create-metadata-index engram-vectors --property-name=conversation_id --type=string
```

**Important:** Metadata indexes must exist before vectors are upserted. Vectors inserted before the index was created won't be filterable.

### Capacity

Each vector is 768 floats × 4 bytes = ~3KB. Vectorize supports 5M vectors on the free tier.

A typical conversation with 100 messages produces ~33 chunks (window=5, stride=3). So 5M vectors ≈ 150K conversations.

---

## How Workers AI Generates Embeddings

Workers AI is Cloudflare's inference platform. Engram uses it to convert text into vectors.

### The model

`@cf/baai/bge-base-en-v1.5` — a 768-dimensional embedding model from the BAAI (Beijing Academy of AI). It's:

- **Free** — no per-request cost on Cloudflare
- **Fast** — runs at the edge, typically 10-30ms per batch
- **Good enough** — not the best embedding model, but excellent quality-to-cost ratio

### How it's called

```typescript
// In services/embedding.ts
const response = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
  text: ["chunk 1 text", "chunk 2 text", "chunk 3 text"]
});

// response.data = [
//   [0.12, -0.45, 0.78, ...],  // 768 numbers for chunk 1
//   [0.34, -0.12, 0.56, ...],  // 768 numbers for chunk 2
//   [0.67, 0.23, -0.89, ...],  // 768 numbers for chunk 3
// ]
```

The call goes to a GPU in Cloudflare's network via the same RPC binding system. Your Worker doesn't call an external API — it's an internal call to a co-located inference node.

### Batching

Engram sends all chunks from an `append_messages` call in a single batch. If you append 20 messages, that produces ~6 chunks, embedded in one AI call. This is much faster than embedding one at a time.

---

## The Chunking Algorithm

When messages are appended, they're grouped into overlapping text windows called **chunks**. Each chunk becomes one vector in the search index.

### Why chunk?

You can't embed an entire conversation as one vector — it would lose detail (one vector can only capture one "meaning"). And embedding each message individually would miss context (a single "yes" message is meaningless without the question before it).

Chunking captures **groups of related messages** — enough context to be meaningful, small enough to be specific.

### How it works

**Window size: 5 messages, Stride: 3, Overlap: 2**

For a conversation with 10 messages:

```
Messages:  [1] [2] [3] [4] [5] [6] [7] [8] [9] [10]

Chunk 1:   [1] [2] [3] [4] [5]
                        ─── overlap ───
Chunk 2:            [3] [4] [5] [6] [7]
                                 ─── overlap ───
Chunk 3:                     [6] [7] [8] [9] [10]
```

- **Chunk 1** covers messages 1–5 (the opening of the conversation)
- **Chunk 2** covers messages 3–7 (overlaps with chunk 1 by 2 messages)
- **Chunk 3** covers messages 6–10 (overlaps with chunk 2 by 2 messages)

The overlap ensures no message context is lost at boundaries. Message 5, for example, appears in both chunk 1 and chunk 2 — so a search about the topic discussed in message 5 will find context from both surrounding message groups.

### Chunk text format

Each chunk is formatted as a readable transcript:

```
[user]: How do I deploy a Cloudflare Worker?
[assistant]: First create the D1 database with wrangler d1 create...
[user]: What embedding model should I use?
[assistant]: For Cloudflare Workers, use bge-base-en-v1.5...
[user]: Thanks, that worked!
```

This format preserves who said what, which helps the embedding model capture conversational context.

### The code

```typescript
// In packages/shared/src/utils/chunk.ts
export function chunkMessages(messages: Message[]): ChunkResult[] {
  const sorted = [...messages].sort((a, b) => a.sequence - b.sequence);
  const chunks: ChunkResult[] = [];

  for (let i = 0; i < sorted.length; i += CHUNK_STRIDE) {  // stride = 3
    const window = sorted.slice(i, i + CHUNK_WINDOW_SIZE);   // window = 5
    if (window.length === 0) break;

    const text = window
      .map((m) => `[${m.role}]: ${m.content}`)
      .join("\n");

    chunks.push({
      text,
      startSequence: window[0].sequence,
      endSequence: window[window.length - 1].sequence,
    });
  }

  return chunks;
}
```

---

## Full Request Lifecycle

### Write Path: append_messages

What happens when an agent sends messages to Engram:

```
MCP Client sends POST /mcp
  │
  │  {"method": "tools/call", "params": {"name": "append_messages", ...}}
  │
  ▼
1. HONO ROUTER receives request
  │
  ▼
2. AUTH MIDDLEWARE
  │  Extract "Authorization: Bearer engram_sk_live_..."
  │  SHA-256 hash the key
  │  Query D1: SELECT * FROM api_keys WHERE key_hash = ?
  │  Verify not expired, not revoked
  │  Extract organization_id → set auth context
  │  Update last_used_at via waitUntil (non-blocking)
  │
  ▼
3. MCP SERVER (created fresh per request)
  │  Parse JSON-RPC → route to append_messages tool handler
  │
  ▼
4. CONVERSATION SERVICE
  │
  ├── 4a. Verify conversation exists
  │   Query D1: SELECT * FROM conversations WHERE id = ? AND organization_id = ?
  │
  ├── 4b. Get max sequence
  │   Query D1: SELECT MAX(sequence) FROM messages WHERE conversation_id = ?
  │
  ├── 4c. Store vault entries (if present)
  │   If vault_entries provided:
  │   Batch insert into secrets_vault (id, encrypted_value, iv, secret_type, ...)
  │   (Server stores opaque blobs — never decrypts)
  │
  ├── 4d. Insert messages
  │   Batch insert into D1: INSERT INTO messages (id, conversation_id, ..., sequence)
  │   Sequences: max_seq + 1, max_seq + 2, ...
  │
  ├── 4e. Update count
  │   D1: UPDATE conversations SET message_count = message_count + N
  │
  ├── 4f. Chunk messages
  │   Sliding window: [msg1..msg5], [msg4..msg8], ...
  │   Format: "[role]: content\n..."
  │
  ├── 4g. Generate embeddings
  │   Workers AI: env.AI.run("@cf/baai/bge-base-en-v1.5", { text: chunk_texts })
  │   Returns: [[0.12, -0.45, ...], [0.34, ...], ...]
  │
  ├── 4h. Store chunks in D1
  │   Batch insert: INSERT INTO conversation_chunks (id, chunk_text, vectorize_id, ...)
  │
  └── 4i. Index in Vectorize
      env.VECTORIZE.upsert([
        { id: "chk_abc", values: [0.12, ...], metadata: {org_id, conv_id} },
        ...
      ])
  │
  ▼
5. RESPONSE
  │  {"appended": 6, "message_ids": ["msg_...", ...]}
  │  Sent as SSE event (text/event-stream)
  ▼
MCP Client receives response
```

**Total latency:** Typically 200-500ms. D1 queries (~5ms each × 4), Workers AI embedding (~30ms), Vectorize upsert (~10ms), network overhead.

### Read Path: search

What happens when an agent searches Engram:

```
MCP Client sends POST /mcp
  │
  │  {"method": "tools/call", "params": {"name": "search", "arguments": {"query": "..."}}}
  │
  ▼
1. AUTH (same as write path)
  │
  ▼
2. SEARCH SERVICE
  │
  ├── 2a. Embed the query
  │   Workers AI: embed("what embedding model to use")
  │   Returns: [0.11, -0.44, 0.77, ...]  (768 floats)
  │
  ├── 2b. Query Vectorize
  │   env.VECTORIZE.query(queryVector, {
  │     topK: 10,
  │     filter: { organization_id: "org_xyz" },
  │     returnMetadata: "all"
  │   })
  │   Returns: [
  │     { id: "chk_abc", score: 0.75 },
  │     { id: "chk_def", score: 0.69 },
  │   ]
  │
  ├── 2c. Fetch chunks from D1
  │   SELECT * FROM conversation_chunks WHERE vectorize_id IN (?, ?)
  │   Gets: chunk_text, start_sequence, end_sequence, conversation_id
  │
  └── 2d. Fetch original messages
      For each chunk:
        SELECT * FROM messages
        WHERE conversation_id = ? AND organization_id = ?
          AND sequence BETWEEN ? AND ?
        ORDER BY sequence
  │
  ▼
3. RESPONSE
  │  {
  │    "results": [
  │      {
  │        "score": 0.75,
  │        "chunk_text": "[user]: What embedding model...\n[assistant]: Use bge-base...",
  │        "messages": [ full original messages with all fields ]
  │      }
  │    ]
  │  }
  ▼
MCP Client receives response
```

**Total latency:** Typically 50-150ms. Embedding (~20ms), Vectorize query (~10ms), D1 fetches (~20ms).

---

## How MCP Works on Workers

The Model Context Protocol uses **Streamable HTTP** transport — each interaction is a standard HTTP POST with a JSON-RPC body.

### The problem

The official MCP SDK ships two transports:
- `StreamableHTTPServerTransport` — for Node.js (uses `req.writeHead`, `res.headersSent`)
- `WebStandardStreamableHTTPServerTransport` — for Web Standard environments (Workers, Deno, Bun)

Workers don't have Node.js HTTP objects. They use the Web Standard `Request`/`Response` API. So Engram uses the Web Standard transport.

### The flow

```typescript
// In src/index.ts
app.all("/mcp", authMiddleware, async (c) => {
  // 1. Create a fresh MCP server for this request
  const server = createMcpServer(c.env, auth);

  // 2. Create a Web Standard transport (stateless)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,  // no sessions — fully stateless
  });

  // 3. Connect server to transport
  await server.connect(transport);

  // 4. Pass the raw Web Request, get back a Web Response
  return transport.handleRequest(c.req.raw);
});
```

### Why per-request servers?

Workers are stateless — there's no persistent process between requests. So Engram creates a new `McpServer` for every request, registers all 6 tools, handles the request, and discards everything. This is fine because:

1. MCP server creation is cheap (~1ms)
2. Tool registration is just function references (no I/O)
3. All state lives in D1 and Vectorize, not in the Worker

### Request format

MCP uses JSON-RPC 2.0 over HTTP POST:

```
POST /mcp
Content-Type: application/json
Accept: application/json, text/event-stream
Authorization: Bearer engram_sk_live_...

{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search","arguments":{"query":"..."}}}
```

Response comes as Server-Sent Events (SSE):

```
event: message
data: {"result":{"content":[{"type":"text","text":"..."}]},"jsonrpc":"2.0","id":1}
```

---

## How Auth Works

### The API key lifecycle

```
Creation:
  Generate: "engram_sk_live_" + 32 random chars
  Hash:     SHA-256("engram_sk_live_aBcD...") → "be36c36b69b565..."
  Store:    INSERT INTO api_keys (key_hash, key_prefix, organization_id, ...)
  Return:   Show raw key to user ONCE — never stored, never retrievable

Authentication (every request):
  Receive: "Authorization: Bearer engram_sk_live_aBcD..."
  Hash:    SHA-256("engram_sk_live_aBcD...") → "be36c36b69b565..."
  Lookup:  SELECT * FROM api_keys WHERE key_hash = "be36c36b69b565..."
  Check:   not revoked? not expired? → extract organization_id
```

### Why hash, not encrypt?

Encryption is reversible — if someone gets the database, they get all API keys. Hashing is one-way — even with full database access, you can't recover the raw keys. This is the same approach Stripe, GitHub, and most API providers use.

### Why prefix?

The `key_prefix` (first 20 chars, e.g., `engram_sk_live_aBcDe`) is stored so keys can be identified in a dashboard. "Which key is making all these requests?" → check the prefix. But the prefix alone isn't enough to authenticate.

---

## Tenant Isolation In Depth

Engram is multi-tenant — multiple organizations share the same Worker, D1 database, and Vectorize index. Isolation is enforced at every layer.

### Layer 1: Authentication

```
API key → organization_id (set once, immutable for the request)
```

The org_id comes from the API key lookup, not from user input. There's no way for a client to specify a different org_id.

### Layer 2: Database queries

```sql
-- Every single D1 query includes organization_id
SELECT * FROM conversations WHERE id = ? AND organization_id = ?
SELECT * FROM messages WHERE conversation_id = ? AND organization_id = ?
INSERT INTO messages (..., organization_id) VALUES (..., ?)
```

The org_id is **denormalized** — stored directly on messages and chunks, not just on the parent conversation. This means:
- No JOINs needed for tenant filtering (faster)
- No risk of a bug in a JOIN leaking data across tenants
- A query against the messages table is self-contained

### Layer 3: Vector search

```typescript
env.VECTORIZE.query(vector, {
  filter: { organization_id: orgId },  // metadata filter
});
```

Vectorize filters by the org_id metadata *before* doing similarity search. Vectors from other orgs are never even considered.

### Layer 4: Application code

The `organizationId` flows through the entire call stack:

```
authMiddleware → sets auth.organizationId
  → createMcpServer(env, auth)
    → tool handler receives auth
      → service function receives organizationId
        → DB query uses organizationId
        → Vectorize query uses organizationId
```

There's no global state, no shared context between requests, and no way to access data from a different org.

---

## Monorepo Architecture

### Package dependency graph

```
@getengram/shared (no dependencies on Cloudflare)
    │
    │  Types, Zod schemas, chunking algorithm,
    │  ID generation, API key hashing
    │
    ▼
@getengram/db (depends on shared for types)
    │
    │  SQL migrations, typed query helpers
    │  (insert, select, update, delete for each table)
    │
    ▼
@getengram/mcp-server (depends on shared + db)
    │
    │  Hono app, auth middleware, MCP server,
    │  tool handlers, services (conversation, embedding, search)
    │
    └── Deployed as a Cloudflare Worker
```

### Why this split?

- **shared** is pure TypeScript — no Cloudflare dependencies. It can be used in tests, scripts, or a future REST API without pulling in Workers types.
- **db** isolates the data layer. If you want to add a new table, you touch `db/migrations/` and `db/src/queries/` — the MCP server doesn't need to know about SQL.
- **mcp-server** is the deployment target. It wires everything together and adds the HTTP/MCP layer.

### Build orchestration

Turborepo builds packages in dependency order:

```bash
pnpm build
  → turbo build
    → @getengram/shared (builds first — no deps)
    → @getengram/db (builds after shared)
    → @getengram/mcp-server (builds last — depends on both)
```

---

## Production Configuration

### wrangler.toml

```toml
name = "engram-mcp-server"
main = "src/index.ts"
compatibility_date = "2024-12-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "engram-db"
database_id = "fcf57f81-8d26-4288-aee5-11c42d6ca0d5"
migrations_dir = "../../packages/db/migrations"

[[vectorize]]
binding = "VECTORIZE"
index_name = "engram-vectors"

[ai]
binding = "AI"

[[routes]]
pattern = "mcp.getengram.app/*"
zone_name = "getengram.app"
```

### DNS

```
mcp.getengram.app  →  AAAA 100:: (proxied)
```

The `100::` address is a dummy — Cloudflare's proxy intercepts the request and routes it to the Worker based on the route pattern. The DNS record just needs to exist and be proxied.

### The full path of a request

```
1. Client sends HTTPS request to mcp.getengram.app
2. DNS resolves to Cloudflare's anycast IP (nearest PoP)
3. Cloudflare terminates TLS (auto-provisioned Let's Encrypt cert)
4. Route pattern matches → request dispatched to engram-mcp-server Worker
5. V8 isolate starts, Worker handles request via Hono.js
6. Worker uses bindings to talk to D1, Vectorize, Workers AI
7. Response sent back through Cloudflare's network
8. Client receives HTTPS response
```

Total infrastructure: zero servers, zero containers, zero config files on a machine somewhere. Just code deployed to Cloudflare's edge.
