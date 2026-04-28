# Twitter/X Thread Draft

## Tweet 1 (hook)

Your AI agents have amnesia.

Every Claude Code session, every Cursor chat, every agent interaction -- gone the moment the terminal closes.

The reasoning, the debugging, the "we chose X because Y" -- all of it, vanished.

We built Engram to fix this.

## Tweet 2

Existing "memory" products extract and summarize your conversations into compressed facts.

"User prefers Postgres" -- but WHY? What version? What benchmark? What was the fallback plan?

Extraction is lossy. The details that matter most get destroyed.

## Tweet 3

Engram stores complete, verbatim conversation transcripts and makes them searchable via semantic search.

No summarization. No extraction. The conversation IS the knowledge base.

Search by meaning, get back the actual words.

## Tweet 4

It's an MCP server. One config block and your agent has persistent memory:

```json
{
  "engram": {
    "url": "https://mcp.getengram.app/mcp",
    "headers": {
      "Authorization": "Bearer engram_sk_live_..."
    }
  }
}
```

Works with Claude Code, Claude Desktop, Cursor, Windsurf, Zed.

## Tweet 5

There's also a CLI with a background daemon that auto-captures your Claude Code sessions:

```
npm i -g @getengram/cli
engram auth login engram_sk_live_...
engram start
```

That's it. Every session is now captured and searchable. No manual effort.

## Tweet 6

Under the hood:
- Cloudflare Workers (<1ms cold start)
- D1 (SQLite at the edge) for verbatim storage
- Vectorize for semantic search
- Workers AI embeddings (free, 768-dim)
- Sliding-window chunking

Entire stack runs on Cloudflare. Zero servers.

## Tweet 7 (CTA)

Engram is live now. Free tier to get started.

Try it: https://getengram.app
SDK + CLI are MIT licensed: https://github.com/get-engram/engram

Your agents should remember. Now they can.
