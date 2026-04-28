# Building Persistent Memory for AI Agents with MCP and Cloudflare

Every AI coding agent has the same problem: amnesia. You spend an hour working through a complex debugging session with Claude, Copilot, or Cursor. You explain your architecture, your constraints, the weird edge case in your auth flow. The agent helps you fix it. You close the session. Next time you open it, the agent has no idea who you are.

This is the problem Engram solves.

## The Problem: Stateless Agents in a Stateful World

Large language models are stateless by design. Each conversation starts from zero. Context windows are getting larger, but they are still finite, and they reset between sessions.

For one-off questions, this is fine. But agents are increasingly used for ongoing work: maintaining codebases, managing infrastructure, iterating on designs over weeks and months. In that world, forgetting everything between sessions is a serious limitation.

Some tools work around this with static markdown files or structured memory banks. These help, but they don't scale. You end up manually curating what to remember, and keyword search over flat files misses the semantic connections that matter.

What you actually want is a system that:

1. Captures full conversation transcripts automatically
2. Chunks and embeds them for semantic search
3. Lets the agent query its own history with natural language
4. Works across sessions, machines, and agent types

That's Engram.

## How Engram Works

The core flow:

1. **Store** — Conversations are saved as a sequence of messages grouped under a conversation with title, tags, and metadata.
2. **Chunk** — Long transcripts are split into overlapping chunks sized for embedding models.
3. **Embed** — Each chunk is passed through an embedding model to produce a vector.
4. **Search** — Agent sends a natural language query. Engram finds the most semantically similar chunks across all stored conversations.

From the agent's perspective:

```
search
  query: "authentication flow for the workers API"
  limit: 5
```

This returns ranked transcript snippets from previous sessions where authentication was discussed — decisions made, bugs found, approaches tried and abandoned.

The key insight is that you store raw transcripts, not summaries. Summaries lose detail. Six months from now, the exact error message or the specific flag that fixed a build matters more than a high-level summary.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  MCP Client                      │
│          (Claude, Cursor, any agent)             │
└──────────────────┬──────────────────────────────┘
                   │ MCP (SSE / streamable HTTP)
                   ▼
┌─────────────────────────────────────────────────┐
│           Cloudflare Worker (Hono.js)            │
│                                                  │
│  ┌───────────┐  ┌───────────┐  ┌─────────────┐  │
│  │ MCP SDK   │  │ Auth      │  │ Chunking    │  │
│  │ Tools     │  │ Middleware │  │ + Embedding │  │
│  └───────────┘  └───────────┘  └─────────────┘  │
└──────┬──────────────┬───────────────┬───────────┘
       │              │               │
       ▼              ▼               ▼
   ┌───────┐    ┌──────────┐   ┌────────────┐
   │  D1   │    │Vectorize │   │ Workers AI │
   │(SQLite)│   │ (Vector  │   │ (Embeddings│
   │       │    │  Index)  │   │  Model)    │
   └───────┘    └──────────┘   └────────────┘
```

**Hono.js on Cloudflare Workers** — The HTTP layer. Hono is a small, fast web framework that works natively on Workers. It handles routing, middleware, and the MCP transport layer.

**D1** — Cloudflare's serverless SQLite database. Stores conversations, messages, and metadata. Relational structure means you can query by tags, date ranges, agent ID, or any combination alongside semantic search.

**Vectorize** — Cloudflare's vector database. Stores the embedding vectors for each transcript chunk. Supports approximate nearest neighbor search.

**Workers AI** — Runs the embedding model at the edge. Transcript chunks go in, 768-dimensional vectors come out. No external API calls, no OpenAI bill, no added latency.

**MCP SDK** — The tools (search, create_conversation, append_messages, etc.) are registered using the Model Context Protocol SDK. Any MCP-compatible client can connect and use them directly.

The entire thing deploys as a single `wrangler deploy`. No containers, no Kubernetes, no Terraform.

## Getting Started

### Install the CLI

```bash
# macOS
brew tap get-engram/engram && brew install engram

# or via npm
npm install -g @getengram/cli
```

### Configure Your MCP Client

For Claude Code, add Engram to your MCP config:

```json
{
  "mcpServers": {
    "engram": {
      "url": "https://mcp.getengram.app/sse",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

### Use It

Once connected, your agent has access to Engram's tools. Add to your `CLAUDE.md`:

```markdown
### On session start
Search Engram for context relevant to the current task:
  search query: "<summary of what the user is asking>" limit: 5

### During the session
When significant decisions are made or bugs are resolved, store them.
```

### Self-Hosting

```bash
git clone https://github.com/get-engram/engram.git
cd engram
pnpm install
pnpm build

cd apps/mcp-server
npm run db:migrate:local   # set up the D1 schema
npm run seed               # generate a test org + API key
npm run dev                # start on localhost:8787
```

## What's Next

- **Cross-agent memory** — share context between Claude Code and Cursor sessions
- **Smarter retrieval** — hybrid search with re-ranking
- **Retention policies** — time-based pruning of old transcripts

## Wrapping Up

The gap between "AI assistant" and "AI colleague" is memory. An assistant answers your question and forgets you. A colleague remembers the last six months of context — what was tried, what failed, why you made the choices you did.

Engram is the infrastructure layer that bridges that gap. It is open source, runs on Cloudflare's edge network, and plugs into any MCP-compatible agent.

If you're building with AI agents and tired of re-explaining your codebase every Monday morning, give it a look: [github.com/get-engram/engram](https://github.com/get-engram/engram)

---

*Engram is open source under the MIT license. Contributions welcome.*
