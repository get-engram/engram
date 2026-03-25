# Comparison with Alternatives

How Engram differs from other agent memory solutions.

## Overview

| Feature | Engram | Mem0 | Zep | Supermemory |
|---------|--------|------|-----|-------------|
| Storage model | Verbatim transcripts | Extracted facts | Summarized memory | Extracted knowledge |
| What you get back | Original conversation | "User prefers dark mode" | Summary + entities | Knowledge graph nodes |
| Data loss | None — full transcript preserved | Details lost in extraction | Details lost in summarization | Context lost in extraction |
| Protocol | MCP (native) | REST API | REST API | REST API |
| Search | Semantic (vector) | Semantic | Semantic + graph | Semantic |
| Self-hostable | Yes (Cloudflare) | Yes | Yes | Yes |
| Infrastructure | Cloudflare (D1 + Vectorize + Workers AI) | Postgres + Qdrant + OpenAI | Postgres + embeddings | Various |
| Embedding cost | Free (Workers AI) | OpenAI API cost | Varies | Varies |

## The Core Difference: Verbatim vs. Extracted

Most memory products follow this flow:

```
Conversation → Extract/Summarize → Store condensed version → Search condensed version
```

Engram's flow:

```
Conversation → Store verbatim → Chunk & embed for search → Search returns original messages
```

### What extraction loses

**Mem0/Zep/Supermemory approach:**
```
Input conversation:
  User: "I tried switching to Postgres 16 but the JSONB GIN indexes were
         30% slower than our MongoDB queries for the nested document
         lookups. We might revisit when Postgres 17 ships with the new
         JSONB path optimizations. For now, keep MongoDB for the catalog
         service but use Postgres for everything else."

Extracted memory:
  "User prefers MongoDB for catalog service, Postgres for other services"
```

The extracted memory loses:
- The specific version (Postgres 16) and why it didn't work
- The benchmark data (30% slower)
- The specific use case (nested document lookups, GIN indexes)
- The forward-looking plan (revisit with Postgres 17)
- The nuance (it's not a preference — it's a performance-driven constraint)

**Engram approach:**

The full conversation is stored and searchable. A search for "MongoDB vs Postgres" returns the exact text above, with all the context intact.

## When to Use Engram

**Engram is the best fit when:**
- You need the full conversation, not just extracted facts
- Conversations contain technical details, reasoning, or nuance that summaries would lose
- You want an audit trail of exactly what was said
- You're building MCP-native agents
- You want to avoid external API costs for embeddings
- You prefer simple infrastructure (single platform: Cloudflare)

**Consider alternatives when:**
- You only need simple key-value memories ("user's name is Alice")
- You want a knowledge graph with entity relationships
- You need memories that update and consolidate over time (e.g., "user moved from NYC to SF" should replace the old location)
- You need real-time memory during a single conversation (Engram is designed for cross-session memory)

## Protocol: MCP vs. REST

Engram is **MCP-native**. It works directly with Claude Desktop, Claude Code, Cursor, Windsurf, and any MCP client without adapter code.

Most alternatives expose REST APIs, which require:
- Custom integration code in your agent
- A tool wrapper to expose the API as an agent tool
- Manual HTTP/auth handling

With Engram, you add a server URL to your MCP config and the tools are immediately available to your agent.

## Cost Comparison

| Component | Engram (self-hosted) | Typical alternative |
|-----------|---------------------|-------------------|
| Compute | Cloudflare Workers free tier | Server/container hosting |
| Database | D1 free tier (5GB) | Managed Postgres ($15-50/mo) |
| Vector DB | Vectorize free tier (5M vectors) | Pinecone/Qdrant ($25-70/mo) |
| Embeddings | Workers AI (free) | OpenAI ada-002 ($0.10/1M tokens) |
| **Total** | **$0** | **$40-120+/month** |

For hosted Engram (when available), pricing will be announced separately.
