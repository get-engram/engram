# Show HN Draft

**Title:** Show HN: Engram – Long-term memory for ChatGPT, Claude, and Cursor

---

I've been using AI assistants daily and the biggest pain point is that every session starts from zero. The model has no memory of what you discussed yesterday — the decisions you made, the bugs you chased, the preferences you stated. You end up re-explaining yourself constantly.

Engram fixes that. It stores your conversations verbatim and makes them searchable by meaning, so your assistant can recall context across sessions instead of forgetting it. Ask it to remember something today and search for it next week.

It's MCP-native (Model Context Protocol), so it works across clients:

- ChatGPT — connect via custom connector in Settings > Apps > Developer mode, add https://mcp.getengram.app/mcp and sign in (OAuth). No install.
- Claude Desktop / Claude Code / Cursor / Windsurf — drop the MCP server URL + an API key into your config.
- For Claude Code, the CLI (npm i -g @getengram/cli) runs a background daemon that auto-captures your sessions so you don't have to think about it.

How it works: the agent calls `search` with a natural-language query and gets back the most relevant snippets from your past conversations; `append_messages` stores new ones. Everything is chunked and embedded automatically. The model decides when to remember and when to recall.

The backend runs entirely on Cloudflare — Workers for the API/MCP server, D1 for storage, Vectorize for semantic search, Workers AI for embeddings. Fast and globally distributed.

Source (Business Source License 1.1): https://github.com/get-engram/engram

There's a free tier (1,000 messages/month) if you want to try it. Pro is $9/mo for heavier use.

I built this because I wanted my assistants to actually learn from our interactions over time — to remember that we chose Hono over Express, that prod needs a specific migration order, that I prefer explicit error handling over swallowing exceptions. The stuff that lives in your head but not in the codebase.

Would love feedback, especially from people using AI assistants daily. What context do you find yourself repeating the most?

Site: https://getengram.app
