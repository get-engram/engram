# Reddit r/LocalLLaMA Draft

**Title:** Engram: self-hostable memory service for AI agents -- MCP-native, runs on Cloudflare free tier, SDK/CLI are MIT

---

I've been building a memory layer for AI agents called Engram. The core idea: store complete, verbatim conversation transcripts and make them searchable via semantic search. No extraction, no summarization -- the full conversation is the knowledge base.

**Why I'm posting here:**

The SDK and CLI are MIT licensed, the server is self-hostable on Cloudflare's free tier, and it uses the Model Context Protocol (MCP) which means it works with any MCP-compatible client. If you're running local models through an MCP-compatible interface, this gives them persistent memory.

**Self-hosting:**

```bash
git clone https://github.com/get-engram/engram.git
cd engram && pnpm install
wrangler login
wrangler d1 create engram-db
wrangler vectorize create engram-vectors --dimensions=768 --metric=cosine
cd apps/mcp-server
npm run db:migrate:remote
npm run seed  # generates org + API key
wrangler deploy
```

Your own instance at `engram-mcp-server.<your-subdomain>.workers.dev`. The entire infrastructure runs on Cloudflare's free tier:

| Service | Free tier |
|---------|-----------|
| Workers | 100K requests/day |
| D1 | 5GB SQLite |
| Vectorize | 5M vectors |
| Workers AI | Unlimited (bge-base-en-v1.5 is free) |

**Architecture:**

- Cloudflare Workers (V8 isolates, stateless, <1ms cold start)
- D1 (managed SQLite at the edge) for conversation/message storage
- Vectorize (HNSW-based ANN index) for semantic search
- Workers AI bge-base-en-v1.5 for embeddings (768 dimensions, cosine similarity)
- Sliding-window chunking: 5-message window, stride of 3, 2-message overlap
- Hybrid search: vector similarity + FTS5 keyword search fused via Reciprocal Rank Fusion (RRF, k=60)
- Multi-tenant with org-scoped metadata filtering at the vector layer

**MCP integration:**

Any MCP client connects with a URL and API key. No SDK integration needed on the client side. The server exposes 6 tools: `create_conversation`, `append_messages`, `search`, `get_conversation`, `list_conversations`, `delete_conversation`.

**What I'd love feedback on:**

- The embedding model choice (bge-base-en-v1.5) -- it's free on Workers AI but limited to English and 768 dims. Would love to hear if anyone has benchmarked alternatives that run well on Cloudflare.
- The chunking strategy -- sliding window with overlap works well empirically but I'm curious if anyone has found better approaches for conversational data.
- Interest in swappable embedding backends for self-hosters who want to use their own models.

GitHub: https://github.com/get-engram/engram
Docs: https://getengram.app/docs
