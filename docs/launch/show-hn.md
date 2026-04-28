# Show HN Draft

**Title:** Show HN: Engram – Persistent memory for AI agents via semantic search

---

I've been using Claude Code daily and the biggest pain point is that every session starts from zero. The agent has no memory of what you discussed yesterday — the bugs you investigated, the architecture decisions you made, the preferences you expressed. You end up repeating yourself constantly.

Engram fixes this. It's a memory service that stores complete conversation transcripts and makes them searchable via semantic search. When a new session starts, the agent searches Engram for relevant context and picks up where you left off.

How it works:

- Install the CLI (`brew tap get-engram/engram && brew install engram` or `npm i -g @getengram/cli`)
- A background daemon watches your Claude Code sessions and auto-captures transcripts
- Engram chunks the conversations and generates embeddings
- The MCP server exposes search/store tools that any MCP-compatible client can use (Claude Code, Cursor, etc.)

It speaks Model Context Protocol (MCP), so the agent calls `search` with a natural language query and gets back relevant snippets from past conversations. No manual note-taking required.

The backend runs on Cloudflare Workers with D1 for storage and Vectorize for embeddings. It's fast and globally distributed.

The whole thing is MIT licensed: https://github.com/get-engram/engram

There's a free tier (50 conversations, 500 messages) if you want to try it. Pro is $39/mo for heavier use.

I built this because I wanted my coding agent to actually learn from our interactions over time — to remember that we chose Hono over Express, that the prod database needs a specific migration order, that I prefer explicit error handling over try/catch. The kind of stuff that lives in your head but not in the codebase.

Would love feedback, especially from other people using AI coding agents daily. What context do you find yourself repeating most often?

Site: https://getengram.app
