# Launch Posts

---

## 1. Reddit — r/ClaudeAI

**Title:** I built a persistent memory layer for Claude Code and Desktop — it remembers your past sessions automatically

**Body:**

I got tired of re-explaining my project's architecture, conventions, and past decisions to Claude every time I start a new session. CLAUDE.md helps, but it's manual and limited. I wanted something that just works — store everything, recall what's relevant.

So I built Engram. It's a memory service that stores your conversations verbatim and makes them searchable by meaning via MCP. When Claude starts a new session, it can search your history and pull in relevant context from days or weeks ago.

The setup for Claude Desktop/Code:

- Add the MCP server URL (`https://mcp.getengram.app/mcp`) + your API key to your MCP config
- Claude gets `search`, `create_conversation`, and `append_messages` tools
- You add a few lines to your CLAUDE.md telling it to search on session start and store important context

For Claude Code specifically, there's a CLI daemon (`npm i -g @getengram/cli`) that runs in the background and auto-captures your sessions. You don't have to prompt Claude to remember things — it just happens. Every conversation gets stored, chunked, and embedded automatically.

What it actually remembers for me:

- "We chose Hono over Express because of Cloudflare Workers compatibility"
- "The prod migration has to run before the seed script"
- "User prefers explicit error handling, no swallowed exceptions"
- Past bug investigations so I don't chase the same issue twice

The backend runs entirely on Cloudflare (Workers, D1, Vectorize). Source is on GitHub under BSL-1.1: https://github.com/get-engram/engram

Free tier is 10,000 messages of memory that never expires, Pro is $9/mo for 1,000,000.

Would love to hear how other Claude Code users handle cross-session memory today. What context do you find yourself repeating?

Site: https://getengram.app

---

## 2. Reddit — r/ChatGPT

**Title:** I built persistent memory for ChatGPT that actually works across sessions — connects via MCP in 30 seconds, no install

**Body:**

ChatGPT's built-in memory is... fine. It stores brief facts. But it doesn't remember the full arc of a conversation — the reasoning, the trade-offs, the stuff that makes follow-up sessions actually productive.

I built Engram to fix this. It stores your complete conversations and makes them searchable by meaning. When you start a new chat, ChatGPT can pull in relevant context from your history — not just "user likes Python" but the actual discussion where you debugged that auth flow last Tuesday.

The setup with ChatGPT is dead simple — no install, no CLI, no API keys to manage:

1. Go to Settings > Apps > Developer mode
2. Add a custom MCP connector: `https://mcp.getengram.app/mcp`
3. Sign in with OAuth when prompted

That's it. ChatGPT gets tools to search your memory and store new conversations. You can tell it "remember this" or ask "what did we discuss about X last week?" and it pulls from your full history.

How it works under the hood: conversations get chunked and embedded. When ChatGPT calls `search`, it does semantic matching — so searching "that database migration issue" finds the relevant conversation even if you never used those exact words.

Free tier gives you 10,000 messages of memory — no monthly cap. Pro is $9/mo if you use it heavily.

Source code (BSL-1.1): https://github.com/get-engram/engram

I'd genuinely like feedback from heavy ChatGPT users. What's the stuff you find yourself re-explaining most often?

Site: https://getengram.app

---

## 3. Reddit — r/LocalLLaMA

**Title:** Engram — open-source, self-hostable memory layer for AI agents (MCP-native, runs on Cloudflare, BSL-1.1)

**Body:**

Releasing Engram — a memory service for AI agents that stores verbatim conversations and makes them searchable via semantic embeddings. It speaks MCP (Model Context Protocol) natively, so any MCP-compatible client can use it.

Why I'm posting here: it's source-available (BSL-1.1) and designed to self-host on Cloudflare's free/cheap tier. The entire stack is:

- **Cloudflare Workers** — API + MCP server (Hono.js)
- **Cloudflare D1** — SQLite-based storage for conversations
- **Cloudflare Vectorize** — vector index for semantic search
- **Cloudflare Workers AI** — embedding generation

You can clone the repo and `wrangler deploy` your own instance. All the D1 migrations are included. The architecture is straightforward: conversations in, chunks + embeddings generated automatically, semantic search out.

The MCP endpoint exposes:

- `search` — natural language query against your conversation history
- `create_conversation` / `append_messages` — store new conversations
- `vault_set` / `vault_get` — key-value store for structured facts

Protocol-wise, it's standard MCP over HTTP with SSE transport. Any agent or client that speaks MCP can connect — that includes Claude, ChatGPT, Cursor, Windsurf, or your own local setup. If you're running a local model with an MCP-compatible wrapper, it should just work.

**Repo:** https://github.com/get-engram/engram

**License:** Business Source License 1.1 — free to use, source available, converts to Apache 2.0 after the change date. You can self-host for your own use. The restriction is on offering it as a competing hosted service.

**CLI:** `npm i -g @getengram/cli` (includes a daemon for auto-capturing Claude Code sessions)

If you don't want to self-host, there's a managed version at https://getengram.app with a free tier (1,000 msgs/mo).

Happy to answer questions about the architecture or MCP integration. PRs welcome.

---

## 4. X/Twitter Thread

**Tweet 1:**

Your AI assistant forgets everything between sessions.

I built Engram — persistent memory for ChatGPT, Claude, Cursor, and Windsurf. It stores your conversations and makes them searchable by meaning.

No more re-explaining your codebase, your preferences, or last week's decisions.

**Tweet 2:**

How it works:

Agent calls `search("that auth bug we fixed")` and gets back the relevant conversation from 3 weeks ago — full context, not a one-line summary.

Under the hood: conversations are chunked, embedded, and indexed. Semantic search, not keyword matching.

**Tweet 3:**

Setup for ChatGPT: Settings > Apps > add MCP connector > sign in with OAuth. Done. 30 seconds, no install.

Setup for Claude/Cursor: drop the MCP server URL in your config. One line.

For Claude Code: the CLI daemon auto-captures every session in the background. Zero friction.

**Tweet 4:**

The stack is fully on Cloudflare — Workers, D1, Vectorize, Workers AI. Globally distributed, fast cold starts.

Source is on GitHub (BSL-1.1). You can self-host the whole thing with `wrangler deploy`.

github.com/get-engram/engram

**Tweet 5:**

What it remembers for me:

- Architectural decisions and why we made them
- Bug investigations I don't want to repeat
- Project conventions that aren't in the README
- The full reasoning behind trade-offs, not just the conclusion

**Tweet 6:**

Free tier: 10,000 messages of memory, free forever
Pro: $9/mo
Team: $27/seat/mo

Try it now — connect in under a minute and give your AI a memory that lasts.

https://getengram.app
