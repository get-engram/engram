# Blog post: How we built Engram on Cloudflare Workers + Vectorize

**Target:** engram-web as `content/blog/architecture-deep-dive.mdx`, or syndicated cross-post to dev.to / the Cloudflare Workers blog.

**Audience:** engineers evaluating memory infra for AI agents. They know what MCP is, they've probably touched Mem0 or written their own pgvector wrapper. They're here for the design decisions, not the marketing.

**Tone:** first person, specific, opinionated. Code snippets are welcome. No emoji. No "blazingly fast".

---

## Title options

1. **How we built Engram: verbatim conversation memory on Cloudflare Workers + Vectorize**
2. Stop summarizing your AI agent's memory: a case for storing the full transcript
3. MCP memory without the vector store tax: Engram's architecture

Going with #1 — descriptive, names the stack, filters for the right reader.

---

## Draft

### Why another memory service

I spent a few months using Claude Code for real engineering work. The thing it's bad at — the thing *every* AI coding agent is bad at — is remembering what happened last session. Every new conversation starts from zero. The design decisions from yesterday, the dead-end we already explored, the reason we rejected approach A in favor of approach B — all of it gets dropped when the window closes.

The "obvious" fix is a memory library. Mem0, Zep, MemGPT, Supermemory — there are a dozen of these. I tried several. They all make the same choice: they run an LLM extractor over the conversation, pull out discrete facts ("user prefers tabs over spaces", "project uses Postgres"), and store those. The original transcript gets discarded.

For retrieval, that's usually fine. For the thing I actually wanted — "pull up the *exact* conversation where we decided to use Cloudflare Workers and tell me why" — it's useless. The extractor had already compressed that away into "project uses Cloudflare Workers", which is true but loses every bit of the reasoning I actually wanted back.

So I built one that doesn't summarize. Engram stores the full, verbatim transcript — every message, every tool call, every tool result — and does semantic search on chunks of it. This post is about how.

### The shape of the problem

Three hard requirements:

1. **Verbatim storage.** Whatever goes in comes back character-for-character. No LLM-in-the-loop rewriting. No "helpful" normalization.
2. **Semantic search.** Users don't remember the exact words they used three weeks ago. They remember the *meaning*. That means vectors.
3. **MCP-native over the wire.** If an agent can't reach it from Claude Desktop, Cursor, Windsurf, and Codex with one line of config, nothing else matters.

And three soft requirements that mattered for making it a real product:

4. **Per-tenant isolation** at the storage *and* index level. No shared vector namespace.
5. **Low global latency.** An MCP `search` call is in the hot path of an agent turn; it can't take 2s.
6. **No ops for the user.** SaaS. You sign up, you get an API key, you plug it in.

### Why Cloudflare Workers

I evaluated three stacks:

- **AWS Lambda + Aurora Serverless + pgvector.** Works, but cold starts are real, and the write path (Lambda → RDS Proxy → Postgres → separate embedding call to OpenAI → upsert) is three or four network hops in different VPCs. You can tune it, but the default shape is slow.
- **Fly.io + Postgres + pgvector + self-hosted embedding model.** Fast, but you own the database. That's a 24/7 on-call commitment I didn't want for a v1.
- **Cloudflare Workers + D1 + Vectorize + Workers AI.** The entire stack — compute, SQL store, vector index, embedding model — lives inside one region boundary. A write is: Worker handles the request, chunks the message, calls `env.AI.run(...)` for embeddings (no egress, no hop), writes to D1, upserts into Vectorize. One fetch in, one response out, everything else is in-region.

The Cloudflare option won because the *shape* of the request made the latency math work without any tuning. No cold starts, no VPC setup, no pgvector extension to maintain. I know "Workers for everything" is a meme, but for this particular workload — small writes, fast vector lookups, global read audience — the match is tight.

### Data model

Three tables in D1:

```sql
-- Organizations: the tenancy boundary.
CREATE TABLE organizations (
  id TEXT PRIMARY KEY,        -- org_xxxxxxxx
  name TEXT NOT NULL,
  tier TEXT NOT NULL,         -- free | pro | team | enterprise
  created_at INTEGER NOT NULL
);

-- Conversations: a thread; belongs to an org.
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,        -- conv_xxxxxxxx
  organization_id TEXT NOT NULL,
  title TEXT NOT NULL,
  agent_id TEXT,              -- 'claude-code', 'cursor', etc.
  tags TEXT NOT NULL,         -- JSON array
  metadata TEXT NOT NULL,     -- JSON object
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id)
);

-- Messages: verbatim. role in (user, assistant, tool).
CREATE TABLE messages (
  id TEXT PRIMARY KEY,        -- msg_xxxxxxxx
  conversation_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,      -- the verbatim text
  tool_call_id TEXT,
  tool_name TEXT,
  sequence INTEGER NOT NULL,  -- ordering within the conversation
  metadata TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);
```

Plus a logical `chunks` index inside Vectorize — each vector's metadata points back to `{organization_id, conversation_id, message_id, start_sequence, end_sequence, chunk_text}`.

The deliberate design choice here: **chunks are first-class in Vectorize but not in D1.** We don't persist the chunks as rows. We persist the message, re-chunk on insert, and the chunks live as vector-index metadata. If we ever want to re-chunk with a different strategy (e.g. to try a bigger embedding model), we replay the messages through the new chunker and replace the vectors — the source of truth is the verbatim message, not the chunk.

### The write path

The hot path of `append_messages`:

```ts
// apps/mcp-server/src/mcp/tools/append-messages.ts (simplified)
for (const msg of input.messages) {
  const messageId = generateId("msg");
  await insertMessage(db, messageId, conversationId, organizationId, msg);

  const chunks = chunkMessage(msg.content, { targetTokens: 400, overlapTokens: 50 });
  const embeddings = await env.AI.run(
    "@cf/baai/bge-base-en-v1.5",
    { text: chunks.map((c) => c.text) }
  );

  await env.VECTORIZE.upsert(
    chunks.map((c, i) => ({
      id: `${messageId}_${i}`,
      values: embeddings.data[i],
      namespace: organizationId, // <-- tenant isolation
      metadata: {
        conversation_id: conversationId,
        message_id: messageId,
        chunk_text: c.text,
        start_sequence: msg.sequence,
        end_sequence: msg.sequence,
      },
    }))
  );
}
```

Two things worth flagging:

1. **`namespace: organizationId` is non-negotiable.** Vectorize queries scoped to a namespace can't return cross-tenant results, full stop. This is the one place you can't let a bug slip through, and having it as a top-level argument to every `upsert`/`query` call makes it hard to forget.
2. **Embedding happens inline, in the request.** For small `append_messages` payloads (a typical agent turn is 1–3 messages), this is fast enough (~100ms for 3 chunks on `bge-base-en-v1.5`). For large backfills we'd need a queue, but we don't have that problem yet and I refuse to build for it prematurely.

### The read path

`search` is dumber than you'd expect:

```ts
const queryVector = await env.AI.run(
  "@cf/baai/bge-base-en-v1.5",
  { text: [input.query] }
);

const results = await env.VECTORIZE.query(queryVector.data[0], {
  namespace: auth.organizationId,
  topK: input.limit ?? 10,
  returnMetadata: "all",
  filter: input.conversation_id
    ? { conversation_id: input.conversation_id }
    : undefined,
});

// Optionally expand each hit with adjacent messages so the agent gets
// context around the chunk, not just the chunk in isolation.
return results.matches.map((m) => ({
  chunk_id: m.id,
  conversation_id: m.metadata.conversation_id,
  chunk_text: m.metadata.chunk_text,
  score: m.score,
  start_sequence: m.metadata.start_sequence,
  end_sequence: m.metadata.end_sequence,
}));
```

That's the whole search. No reranking (yet), no hybrid BM25 fusion (yet), no cross-encoder (yet). I want to get real usage data before I add complexity. Current recall is good enough that every search I've run on my own dogfooding history returns the right chunk in the top 3.

### The MCP wire contract

I have strong opinions about wire contracts. In this codebase the MCP tool layer exposes snake_case field names (`conversation_id`, `tool_call_id`, `chunk_id`) because that's what the JSON-RPC payload looks like and it matches D1's column naming. The TypeScript SDK exposes camelCase names (`conversationId`, `toolCallId`, `chunkId`) because that's what idiomatic TS wants.

The mapping between them is hand-written in `client.ts` — which means every time someone adds a column, there are *three* places to update: the shared type, the SDK type, and the mapper. Getting any one of them wrong silently returns `undefined` for the new field.

I lost an afternoon to this exact bug. So I added two kinds of tests:

1. **Type-level sync tests** (`sdk-shared-sync.test.ts`) that use mapped types to force the compiler to enumerate every field:

    ```ts
    type FieldMap<S, D> = { [K in keyof S]: keyof D };
    type ReverseFieldMap<S, D> = { [K in keyof D]: keyof S };

    const sharedToSdk: FieldMap<SharedConversation, SdkConversation> = {
      id: "id",
      organization_id: "organizationId",
      title: "title",
      agent_id: "agentId",
      // ... if you miss a field, it doesn't compile.
    };
    ```

    If either side of the mapping grows a field and the other doesn't, the object literal is ill-typed and TypeScript errors out at build time. No runtime reliance, no assertions that might get skipped — the compiler is the test.

2. **Wire-contract tests** (`mcp-tools-contract.test.ts`) that register each MCP tool with a capture-only server shim, invoke the handler, and assert the exact wire field names. If someone renames `chunk_id` to `chunk_key` in `search.ts`, the test fails with a clear message.

These two tests together pin the three-layer contract (D1 schema ↔ MCP wire ↔ SDK) so drift can't sneak in. I recommend this pattern for anyone else building a typed SaaS API with a hand-written SDK.

### What I'd do differently

Three things that are technically debt I'm already budgeting to pay off:

- **Chunking is naive.** `chunkMessage` does fixed-token windowing with overlap. A message-aware strategy (don't split across role boundaries, don't split inside code fences) would improve recall on mixed-role conversations. Haven't done it yet because the naive version is already passing my dogfooding bar.
- **No hybrid search.** Pure vector for now. I want BM25 + RRF + cross-encoder rerank eventually. The reason it's not there yet is that I don't have enough query volume to tune the weights — it would be theater.
- **No async embedding backfill.** For huge `append_messages` calls we'd want to ack the write immediately and embed in a queue. We don't currently, because typical calls are small. The day we see a bulk importer is the day I add Cloudflare Queues.

### What I'd tell someone building this today

- Pick the runtime where the write path has the fewest hops. For us that was Workers. Yours may differ.
- Tenant isolation belongs at the index layer, not in application code. Namespace everything.
- Store the source of truth at the message level, not the chunk level. Re-chunking is cheap if you can replay.
- Write the type-sync test before you write the second caller of the type. You will forget to update the mapper.
- Don't build hybrid search until you have enough query volume to tune it. Pure vector is a fine v1.

---

## Publication checklist

- [ ] Drop into `engram-web/content/blog/architecture-deep-dive.mdx` with frontmatter (`title`, `description`, `date`, `author`).
- [ ] Add to `engram-web/content/blog/_meta.ts` for Nextra sidebar.
- [ ] Wire into the sitemap (`src/app/sitemap.ts`).
- [ ] Add a JSON-LD `TechArticle` schema block at the top of the MDX.
- [ ] Cross-post to dev.to and Hashnode with canonical URL pointing at getengram.app.
- [ ] Pitch to the Cloudflare Workers blog — they'll usually accept a well-written post that shows off the platform, and it's an enormous distribution unlock.
- [ ] Add a "read the architecture post" link from `docs/architecture.mdx`.
