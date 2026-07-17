# Show HN Draft

**Title:** Show HN: Engram – Persistent memory for AI coding agents

---

I use Claude Code for hours every day. The biggest friction isn't the model — it's that every session starts from scratch. The agent forgets the bugs you investigated together, the architecture decisions you made, the user preferences you expressed. You end up repeating yourself constantly.

Engram is a memory layer for AI agents. It stores complete conversation transcripts, chunks them, and makes them searchable via hybrid semantic + keyword search. When a new session starts, the agent searches Engram and picks up where you left off.

How it works:

- Install the CLI (`brew install get-engram/engram/engram` or `npm i -g @getengram/cli`)
- A background daemon auto-captures your Claude Code sessions
- Conversations are chunked, embedded, and indexed (both vector and full-text)
- The MCP server exposes search/store tools that any MCP-compatible client can use (Claude Code, Cursor, Windsurf, etc.)

The agent calls `search("the auth bug we fixed last week")` and gets back relevant conversation snippets with context. No manual note-taking.

What's under the hood:

- Hybrid search: Cloudflare Vectorize for semantic similarity + D1 FTS5 for keyword matching, combined via Reciprocal Rank Fusion
- Recency-weighted scoring — recent conversations rank higher when you say "remember what we were working on"
- Zero-knowledge secrets vault — the agent can store API keys and credentials client-side encrypted; the server never sees plaintext
- Immutable audit log for every data access
- GDPR compliant (right to erasure, data portability, full export)

Backend is Cloudflare Workers + D1 + Vectorize. Globally distributed, no cold starts.

Server is BSL 1.1 (converts to open source after 4 years). SDK is MPL 2.0. Source: https://github.com/get-engram/engram

Free tier: 1,000 messages/month, unlimited conversations. Pro is $39/mo for heavier use. Teams at $49/seat/mo.

I built this because I wanted my coding agent to actually learn from our work together — to remember that we chose Hono over Express, that the prod database needs a specific migration order, that I prefer explicit error handling over try/catch. The kind of context that lives in your head but nowhere in the codebase.

Would love feedback from other people using AI coding agents daily. What context do you find yourself repeating most?

Site: https://getengram.app
