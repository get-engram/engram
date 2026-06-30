# Show HN Draft

**Title:** Show HN: Engram – Long-term memory for ChatGPT, Claude, and Cursor

> Draft — not posted. Post from your own HN account when ready (ideally once the
> ChatGPT App Directory listing is approved). Be available to answer comments in
> the first hour.

---

I've been using AI assistants daily and the biggest pain point is that every session starts from zero. The model has no memory of what you discussed yesterday — the decisions you made, the bugs you chased, the preferences you stated. You end up re-explaining yourself constantly.

Engram fixes that. It stores your conversations verbatim and makes them searchable by meaning, so your assistant can recall context across sessions instead of forgetting it. Ask it to remember something today and search for it next week.

It's MCP-native (Model Context Protocol), so it works across clients:

- **ChatGPT** — connect it as a custom connector: Settings → Apps → Developer mode → add `https://mcp.getengram.app/mcp` and sign in (OAuth). No install.
- **Claude Desktop / Claude Code / Cursor / Windsurf** — drop the MCP server URL + an API key into your config.
- For Claude Code specifically, the CLI (`npm i -g @getengram/cli`) runs a background daemon that auto-captures your sessions, so you don't have to think about it.

How it works: the agent calls `search` with a natural-language query and gets back the most relevant snippets from your past conversations; `append_messages` stores new ones. Everything is chunked and embedded automatically. The model decides when to remember and when to recall.

The backend runs entirely on Cloudflare's developer platform — Workers for the API/MCP server, D1 for storage, Vectorize for semantic search, Workers AI for embeddings. Fast and globally distributed.

Source (Business Source License 1.1): https://github.com/get-engram/engram

There's a free tier (1,000 messages/month) if you want to try it. Pro is $39/mo for heavier use.

I built this because I wanted my assistants to actually learn from our interactions over time — to remember that we chose Hono over Express, that prod needs a specific migration order, that I prefer explicit error handling over swallowing exceptions. The stuff that lives in your head but not in the codebase.

Would love feedback, especially from people using AI assistants daily. What context do you find yourself repeating the most?

Site: https://getengram.app

---

## How to post (yourself)

1. Go to https://news.ycombinator.com/submit (logged into your account).
2. **Title:** `Show HN: Engram – Long-term memory for ChatGPT, Claude, and Cursor`
3. **URL:** `https://getengram.app` (or leave blank and paste the text below as the post body — a text Show HN often does better for discussion).
4. Paste the body above as the first comment if you used the URL field.
5. Post in the morning US time (Tue–Thu tends to be best), then **stay and reply to comments** for the first hour.

### Accuracy checklist (don't repeat the old draft's mistakes)
- License is **BSL-1.1**, not MIT.
- Free tier is **1,000 messages/month**.
- Don't claim a Homebrew tap until `engram` is actually on homebrew (issue #36).
- Only say "in the ChatGPT App Directory" once it's **approved** — until then, "connect via a custom connector."
