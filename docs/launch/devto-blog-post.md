# How I Gave My AI Coding Agent Persistent Memory in 2 Minutes

Every AI coding session starts the same way: you explain your project, your conventions, your preferences, and the context from last week's debugging session. Then you do it all again tomorrow.

I built [Engram](https://getengram.app) to fix this. It gives ChatGPT, Claude Code, Cursor, and Windsurf a persistent memory that survives across sessions — so your AI actually remembers what you discussed yesterday.

## The Problem

AI assistants are stateless. Each session starts from zero. There are workarounds:

- **CLAUDE.md / .cursorrules** — manual, limited, you maintain it by hand
- **ChatGPT's built-in memory** — stores brief facts like "user likes Python," not the full reasoning behind decisions
- **Copy-pasting context** — tedious, doesn't scale

None of these capture the *full arc* of a conversation — the trade-offs you evaluated, the bugs you investigated, the reasoning behind decisions.

## What Engram Does

Engram stores your conversations verbatim and makes them searchable by meaning. When your AI starts a new session, it can search your history and pull in relevant context from days or weeks ago.

It works through [MCP](https://modelcontextprotocol.io) (Model Context Protocol), so any compatible client can use it. Your AI gets three core tools:

- `search` — "what did we decide about the auth flow?" finds the relevant conversation even if you never used those exact words
- `create_conversation` / `append_messages` — stores new conversations automatically
- `vault_set` / `vault_get` — key-value store for structured facts

Under the hood, conversations are chunked and embedded using vector embeddings. Search is semantic — it matches by meaning, not keywords.

## Setup: ChatGPT (30 seconds, no install)

1. Go to **Settings > Apps > Developer mode**
2. Add a custom MCP connector: `https://mcp.getengram.app/mcp`
3. Sign in with OAuth when prompted

That's it. No CLI, no API keys, no install. ChatGPT can now search your history and store new conversations.

Try asking: *"What did we discuss about [topic] last week?"*

## Setup: Claude Code (one config line + auto-capture)

Add to your MCP config (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "engram": {
      "type": "http",
      "url": "https://mcp.getengram.app/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

Then add a few lines to your `CLAUDE.md` telling Claude to search on session start:

```markdown
## Memory

On session start, search Engram for context relevant to the current task:
- search query: "<summary of what the user is asking about>"

When important decisions or context are established, store them in Engram.
```

### Auto-capture with the CLI daemon

For zero-friction capture, install the CLI:

```bash
npm i -g @getengram/cli
engram daemon start
```

The daemon runs in the background and auto-captures every Claude Code session. You don't have to prompt Claude to remember things — it just happens.

## Setup: Cursor / Windsurf

Same as Claude — add the MCP server URL + API key to your MCP config. Both support MCP natively.

## What It Actually Remembers

After a few weeks of use, here's the kind of context Engram surfaces for me:

- *"We set up OAuth 2.1 with Dynamic Client Registration for the ChatGPT integration"*
- *"The rate limiter is 30 req/min for free tier, 120 for pro"*
- *"User prefers explicit error handling, no swallowed exceptions"*
- Past bug investigations so I don't chase the same issue twice
- Architecture decisions and the full reasoning behind trade-offs

The key difference from CLAUDE.md: I don't maintain any of this manually. Conversations are stored as they happen, and the right context surfaces when it's relevant.

## How It Works (for the curious)

The backend runs entirely on Cloudflare:

- **Workers** — API + MCP server (Hono.js)
- **D1** — SQLite storage for conversations
- **Vectorize** — vector index for semantic search
- **Workers AI** — embedding generation (bge-base-en-v1.5)

When you store a conversation, Engram:
1. Splits it into chunks (512 tokens each)
2. Generates vector embeddings for each chunk
3. Indexes them in Vectorize

When you search, it:
1. Embeds your query
2. Finds the most similar chunks via cosine similarity
3. Returns the relevant conversation snippets with full context

The whole thing is globally distributed with sub-100ms cold starts.

## Pricing

- **Free** — 10,000 messages of memory, free forever (no monthly cap — enough to feel it remember you)
- **Pro** — $9/month for heavier use
- **Team** — $27/seat/month with shared memory across your team

## Source Code

The source is on GitHub under BSL-1.1 (converts to Apache 2.0 after the change date). You can self-host the whole thing on Cloudflare's free tier with `wrangler deploy`.

**GitHub:** [github.com/get-engram/engram](https://github.com/get-engram/engram)

## What's Next

I'm working on:
- Smarter retrieval (re-ranking, context window optimization)
- Team memory sharing (your whole team's knowledge, searchable)
- More client integrations

## Try It

If you're tired of re-explaining yourself to your AI every session:

1. **ChatGPT users:** Settings > Apps > add `https://mcp.getengram.app/mcp`
2. **Claude/Cursor users:** [getengram.app](https://getengram.app) for an API key, then add the MCP config
3. **Claude Code users:** install `@getengram/cli` for auto-capture

The free tier is enough to see if it's useful for your workflow. I'd love to hear what context you find yourself repeating the most.

---

*[Engram](https://getengram.app) is built by [Get Engram Inc](https://github.com/get-engram). Questions? hello@getengram.app*
