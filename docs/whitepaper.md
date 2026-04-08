# The Memory Problem: Why AI Agents Forget and How to Fix It

**A technical white paper from Engram**

---

## Abstract

Most agent runtimes do not provide portable, transcript-level persistent memory by default. Every conversation starts from zero — no memory of prior sessions, no recall of decisions made, no awareness of context established yesterday. This paper examines why persistent memory is the missing infrastructure layer for AI, why existing approaches (memory extraction, RAG, fine-tuning) fail to preserve the richness of conversational knowledge, and how verbatim transcript storage with semantic search offers a fundamentally better architecture. We present Engram, an open-source memory service built on this principle, and argue that the future of AI lies not in larger context windows but in smarter memory.

---

## 1. The Problem: No Portable, Persistent Memory

Every AI conversation begins with amnesia.

You spend an hour with an AI agent debugging a complex authentication flow. You trace the issue through three microservices, identify a race condition in the token refresh logic, and land on a fix. The agent understands your codebase, your naming conventions, your architectural preferences. It knows that you chose Postgres over MongoDB last month because of JSONB GIN index performance, and it knows not to suggest mocking the database in tests because of the incident that burned you in Q4.

Then you close the terminal.

The next morning, you open a new session. The agent knows nothing. Not the bug you fixed. Not the decision you made. Not the preferences you expressed across dozens of prior conversations. You are starting from zero, again, with an agent that has no idea who you are.

Some products have begun addressing this — session memory, profile memory, app-level persistence. But these are proprietary, siloed within individual products, and rarely preserve the full transcript. Most agent runtimes do not provide portable, transcript-level persistent memory by default. Despite models with 200K+ token context windows, despite tool use and function calling, despite agent frameworks that can browse the web and execute code — the fundamental problem remains: **most AI agents do not remember across sessions in a way that is portable and complete.**

The cost of this amnesia is measured in wasted time, repeated explanations, lost decisions, and a persistent inability for AI to compound its usefulness over time. A human colleague who forgot every conversation overnight would be considered impaired. We accept this behavior from AI agents only because we haven't built the infrastructure to fix it.

---

## 2. Current Approaches and Their Limitations

The industry has recognized the memory problem. Several approaches have emerged, each with significant trade-offs.

### Retrieval-Augmented Generation (RAG)

RAG systems retrieve relevant documents and inject them into the prompt. This works well for static knowledge — documentation, manuals, research papers. But conversations are not documents. A conversation has temporal structure, speaker roles, implicit context, and reasoning that unfolds across multiple turns. Naive document-style RAG over transcripts loses this conversational structure. Chunking a conversation the same way you chunk a PDF throws away the speaker turns, the back-and-forth reasoning, and the implicit context that makes it meaningful.

### Memory Extraction

Products like Mem0, Zep, and Supermemory take a different approach: they extract structured "memories" from conversations. A conversation about database preferences becomes a fact: _"user prefers Postgres over MongoDB."_ A debugging session becomes: _"auth service has a race condition in token refresh."_

Fact extraction is useful for compact personalization — quick lookups of user preferences, entity relationships, and simple state. But it is lossy for decision provenance and reasoning history. Consider this exchange:

> **User:** "I tried switching to Postgres 16 but the JSONB GIN indexes were 30% slower than our MongoDB queries for the nested document lookups. We might revisit when Postgres 17 ships with the new JSONB path optimizations. For now, keep MongoDB for the catalog service but use Postgres for everything else."

An extraction system produces: _"User prefers MongoDB for catalog service, Postgres for other services."_

What's lost? The specific version tested (Postgres 16). The benchmark data (30% slower). The specific use case where it failed (nested document lookups with GIN indexes). The forward-looking plan (revisit with Postgres 17). The nuance that this isn't a preference — it's a performance-driven constraint with an expiration date.

When an agent retrieves the extracted memory six months later, it knows _what_ was decided but not _why_. It can't evaluate whether the reasoning still holds. It can't tell the user "Postgres 17 shipped last month with those JSONB optimizations — should we revisit the catalog service?" because that context was destroyed at extraction time.

### Fine-Tuning

Fine-tuning embeds knowledge directly into model weights. But it's expensive, slow (hours to days), doesn't work for per-user or per-session memory, and produces a model that's difficult to update incrementally. You can't fine-tune a model every time a user makes a decision.

### Larger Context Windows

Context windows have grown from 4K to 200K+ tokens in two years. But larger windows are not memory — they're temporary working space. You can fit more into a single session, but it all vanishes when the session ends. And even 200K tokens is insufficient for an agent that should recall information from hundreds of prior conversations.

---

## 3. The Verbatim Approach: Conversations as Knowledge

Engram is built on a single insight: **the conversation itself is the richest form of knowledge an AI interaction produces.**

A conversation contains not just decisions but reasoning. Not just answers but the questions that prompted them. Not just solutions but the failed attempts that preceded them. This context — the full texture of an interaction — is exactly what makes memory useful. An agent that remembers the conversation can re-evaluate decisions, understand constraints, and build on prior work in ways that an agent holding extracted facts cannot.

### How Verbatim Storage Works

When messages are sent to Engram, they are stored exactly as written. No summarization, no extraction, no transformation. Every word, every tool call, every response is preserved in its original form.

But storing full conversations is only half the problem. The other half is making them searchable. You can't scan through thousands of conversations linearly — you need a way to find the relevant fragments quickly, by meaning rather than by keyword.

### Chunking: Searchable Without Losing Context

Engram solves retrieval through a sliding window chunking algorithm. Conversations are divided into overlapping groups of messages — windows of 5 messages with a stride of 3. This creates chunks that overlap by 2 messages, ensuring no conversational context is lost at chunk boundaries.

```
Messages:  [1] [2] [3] [4] [5] [6] [7] [8] [9] [10]

Chunk 1:   [1] [2] [3] [4] [5]
                        ─── overlap ───
Chunk 2:            [3] [4] [5] [6] [7]
                                 ─── overlap ───
Chunk 3:                     [6] [7] [8] [9] [10]
```

Each chunk preserves enough conversational context to be meaningful on its own — a question and its answer, a tool call and the discussion around its results, a decision and the reasoning that led to it.

**An implementation caveat:** the bge-base-en-v1.5 model on Workers AI has a maximum input of 512 tokens. A 5-message sliding window can exceed that in real conversations with long messages, which means chunks may be truncated at the embedding stage. This doesn't break the system — the stored messages remain verbatim regardless — but it means the search embedding may not capture the full text of very long chunks. Explicit preprocessing or adaptive window sizing can mitigate this, and is an area of active improvement.

### Embeddings: Meaning, Not Keywords

Each chunk is converted into a 768-dimensional vector using the bge-base-en-v1.5 embedding model. These vectors capture semantic meaning: a search for "database performance issues" will find a conversation about "JSONB GIN indexes being 30% slower" even though no keywords overlap.

When an agent searches Engram, the query is embedded with the same model and compared against all stored chunks using cosine similarity. The most relevant chunks are returned — along with the original, verbatim messages. The agent gets back the actual conversation, not a summary of it.

---

## 4. Architecture for the Edge

Engram runs entirely on Cloudflare's edge network. This is an architectural choice with significant implications for performance, cost, and operational complexity.

### Why Edge Computing

Traditional memory services require provisioning servers, managing databases, configuring connection pools, and handling scaling. Engram requires none of this. The entire system — compute, database, vector search, and embedding generation — runs on Cloudflare's infrastructure with zero servers to manage.

**Cloudflare Workers** provide the compute layer. Workers are V8 isolates — the same JavaScript engine that runs in Chrome, but without a browser. They avoid traditional container-style cold starts, which can materially reduce startup latency compared to the 100ms–5s boot times typical of containerized deployments. There are no idle costs and no connection pools to manage.

**D1** provides structured storage. D1 is SQLite running as a service on Cloudflare's network — the same embedded database that runs on your phone, but managed with replication support. With D1 read replication enabled via the Sessions API, read queries can be served from nearby replicas. Writes go to a single primary for consistency.

**Vectorize** provides semantic search. It stores the embedding vectors and performs approximate nearest neighbor (ANN) search, filtered by tenant metadata. Cloudflare Vectorize's free tier includes 5 million stored vector dimensions. With bge-base-en-v1.5 producing 768-dimensional embeddings, this accommodates roughly 6,500 vectors — sufficient for small-scale prototyping but not large production memory corpora. Paid plans increase this significantly.

**Workers AI** generates embeddings. The bge-base-en-v1.5 model runs at the edge, co-located with the Worker that calls it. There is no external API call — it's an internal RPC to a co-located inference node. Workers AI includes a free allocation; usage beyond that is billed per request.

### The Binding Model

The critical architectural detail is how these services communicate. Workers don't make HTTP requests to D1 or Vectorize — they use **bindings**, which are internal RPC calls routed within Cloudflare's network. There's no DNS lookup, no TLS handshake, no HTTP parsing. This significantly reduces per-call overhead compared to traditional API-based architectures.

In our testing, the full write path — authenticate, store messages, chunk, embed, index — completed in 200–500ms. The search path — authenticate, embed query, vector search, fetch messages — completed in 50–150ms. These numbers will vary by region, payload size, and Cloudflare infrastructure load, but they illustrate the performance profile achievable with zero self-managed infrastructure.

### Cost

At small scale, Engram can run entirely within Cloudflare's free tiers. Workers, D1, Vectorize, and Workers AI all offer free allocations that are sufficient for individual developers and small teams getting started. Beyond those free tiers, Cloudflare's usage-based pricing applies — but the serverless model means you pay only for what you use, with no baseline infrastructure cost.

---

## 5. The Protocol Layer: MCP as Universal Memory Interface

Engram is built on the Model Context Protocol (MCP), an open standard for communication between AI agents and tools. This choice has consequences that extend beyond technical convenience.

### Why MCP Over REST

Most memory services expose REST APIs. This means every client needs custom integration code — HTTP client setup, authentication handling, request/response serialization, error handling, and a tool wrapper to expose the API as something an agent can use. Each integration is bespoke.

MCP inverts this. An MCP server declares its tools — their names, parameters, and descriptions — and clients that support the relevant MCP transport can discover and use them with minimal configuration. Adding Engram to Claude Code, Cursor, Windsurf, or Codex requires a single configuration block: a URL and an API key. No adapter code. No SDK installation. No custom integration.

This is the difference between a memory service that's technically available and one that's practically used. The lower the integration barrier, the more likely developers are to actually give their agents memory.

### Six Tools Is All You Need

Engram exposes exactly six MCP tools: `create_conversation`, `append_messages`, `search`, `get_conversation`, `list_conversations`, and `delete_conversation`. This is deliberately minimal.

The temptation in building a memory service is to add complexity — entity extraction, relationship graphs, memory consolidation, importance scoring, forgetting curves. Each addition makes the system harder to understand, harder to debug, and harder to trust. Engram's position is that the hard work should be done by the agent (deciding what to store and when to search), not by the memory layer (transforming what was stored).

A simple memory layer that stores exactly what you give it and returns exactly what matches is easier to reason about, easier to debug, and produces more predictable results than a complex system that transforms your data in opaque ways.

### Auto-Memory: Agents That Remember Without Being Asked

The most powerful pattern enabled by MCP integration is **auto-memory** — agents that store and recall context automatically, without explicit user instructions.

The setup is simple. A project configuration file (like `CLAUDE.md` for Claude Code or `.cursorrules` for Cursor) instructs the agent:

1. At the start of every session, search Engram for context relevant to the user's first message
2. During the session, store important decisions, investigations, and context
3. Use descriptive titles and tags so future searches find the right conversations

From the user's perspective, the agent simply remembers. It recalls Monday's architecture decision during Thursday's implementation. It knows the user's coding preferences without being told again. It picks up debugging where the last session left off.

---

## 6. Security and Isolation

A memory service that stores verbatim conversations must take security seriously. Conversations contain sensitive information — architecture details, API configurations, business logic, customer data.

### Multi-Tenant Isolation

Engram is multi-tenant by design. Multiple organizations share the same infrastructure, but data is isolated at every layer. The `organization_id` is derived from the API key during authentication — it cannot be specified or overridden by the client. Every database query includes an organization filter. Every vector search is scoped by organization metadata. The organization ID is denormalized onto every record (messages, chunks) so that no JOIN can accidentally leak data across tenants.

### API Key Security

API keys are never stored. When a key is created, its SHA-256 hash is stored in the database and the raw key is shown to the user once. Authentication works by hashing the provided key and comparing it to stored hashes. Even with full database access, an attacker cannot recover usable API keys. This is the same approach used by Stripe, GitHub, and most modern API providers.

### Self-Hosting

For organizations that cannot send conversation data to a third party, Engram is fully self-hostable on Cloudflare. The deployment requires a single `wrangler deploy` command and uses only Cloudflare services — no external dependencies, no data leaving the Cloudflare network.

---

## 7. The Future of AI Memory

Memory is not a feature of AI products. It is an infrastructure layer — as fundamental as compute, storage, and networking. The trajectory of AI development makes this increasingly clear.

### Memory That Compounds

Today, each AI session is independent. The value of an AI agent is roughly constant — it's as helpful in session 100 as it was in session 1. With persistent memory, value compounds. Session 100 benefits from the context of the 99 sessions that preceded it. The agent understands not just the codebase (which it can read) but the history of decisions, the reasoning behind the architecture, the user's preferences and constraints, the bugs that were investigated and the solutions that were tried.

This compounding effect transforms AI from a tool you use to a collaborator that grows with you.

### Cross-Agent Memory

Most developers use multiple AI tools — a CLI agent for coding, a desktop app for research, an IDE agent for code review. Today, these are isolated islands. Knowledge gained in one tool is invisible to the others.

With a shared memory layer, all agents contribute to and draw from the same organizational knowledge. A bug investigated in Claude Code is recalled by Cursor. An architecture decision discussed in Claude Desktop informs Codex. The memory doesn't belong to any single tool — it belongs to the organization.

### Cross-Tool, Cross-Device Memory

Memory should follow you, not your tool. The same Engram organization can be connected to every AI tool you use — CLI, desktop, IDE, mobile. A preference expressed to your phone assistant is recalled by your coding agent. A decision made in a desktop conversation informs a CI/CD agent running in a pipeline.

This is the "personal AI memory" that the industry has been promising — not a feature of one product, but an open infrastructure layer that any MCP-compatible agent can use.

### From Personal to Organizational

Individual memory is the starting point, but organizational memory is the destination. When every AI interaction across a team flows into a shared memory layer, the organization develops a collective intelligence that persists across employee turnover, project transitions, and tool migrations.

A new engineer's AI agent can search the organization's memory for "why did we choose this architecture?" and find the actual conversation — with all the reasoning, constraints, and alternatives discussed — from six months ago. The knowledge isn't locked in someone's head or buried in a Confluence page that's already outdated. It's in the conversations, verbatim, searchable by meaning.

### What Becomes Possible

When agents truly remember, entirely new capabilities emerge:

**Onboarding agents** that know every architectural decision, every bug investigation, every coding convention discussion from the team's history. A new developer asks "how does the auth flow work?" and the agent answers not from documentation but from the actual conversations where the auth flow was designed, debugged, and refactored.

**Support agents** that know every customer interaction verbatim. When a customer calls back about an issue from three months ago, the agent has the full context — not a summary that says "customer had billing issue" but the exact conversation including tool call results, specific error messages, and the resolution that was applied.

**Research agents** that build on their own prior investigations. Instead of starting each research task from scratch, the agent searches its memory for related prior work and extends it. Research becomes cumulative rather than repetitive.

**Personal assistants** that understand your decision-making patterns, your communication preferences, and the full context of your work — not because they were explicitly told, but because they remember every conversation where these patterns were demonstrated.

---

## 8. Conclusion

The AI industry has spent enormous resources on making models smarter — more parameters, longer context windows, better reasoning. These advances matter. But a brilliant agent that forgets everything between sessions is fundamentally limited in a way that no amount of model improvement can fix.

Memory is the missing layer. Not memory as a feature bolted onto individual products, but memory as infrastructure — open, standardized, self-hostable, and accessible to any agent through a common protocol.

Engram's thesis is simple: **the conversation is the knowledge base.** Don't extract from it. Don't summarize it. Don't compress it. Store it verbatim, chunk it for searchability, embed it for semantic retrieval, and let the agent access the full richness of what was actually said.

The technology to build this exists today. MCP provides the protocol. Edge platforms like Cloudflare provide the infrastructure. Embedding models are accessible and increasingly affordable. Vector databases are mature. What's been missing is the conviction that memory deserves to be its own layer — not a feature of ChatGPT or Claude or Cursor, but a service that sits beneath all of them, accumulating knowledge, compounding value, and making every AI interaction better than the last.

The agents of the future will remember. The question is whether that memory will be proprietary and siloed inside each product, or open and portable across every tool you use. Engram exists to make sure it's the latter.

---

*Last updated: March 2026*

*Visit [getengram.app](https://getengram.app) to get started.*
