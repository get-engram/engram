# Reddit r/ClaudeAI Draft

**Title:** I built a memory layer for Claude Code -- every session is now searchable across projects

---

I've been using Claude Code daily for months and the biggest pain point has been context loss between sessions. Every morning it's a fresh start. "We decided X because Y" on Monday? Gone by Tuesday. The debugging session where we traced that auth bug through three files? Evaporated.

I built Engram to solve this. It's an MCP server that stores your complete conversation transcripts and makes them searchable via semantic search.

**How it works with Claude Code:**

1. Add Engram as an MCP server in your settings (one JSON block with URL + API key)
2. Add a few lines to your CLAUDE.md telling the agent to search Engram at session start and store important context during the session
3. That's it. The agent handles memory automatically from there.

What this looks like in practice: On Monday, you discuss switching from MySQL to Postgres and the reasoning. On Thursday, you ask the agent to set up the database. It searches Engram, finds Monday's conversation, and says "Setting up Postgres -- we decided on Monday to use it because of the JSONB support for the catalog schema." No re-explaining.

**The daemon (auto-capture):**

There's also a CLI with a background daemon that watches your `~/.claude/projects/` directory and auto-captures every Claude Code session without any manual effort:

```
npm i -g @getengram/cli
engram auth login engram_sk_live_YOUR_KEY
engram start
engram install   # auto-start on login via launchd
```

Then later:
```
engram search "when did we deploy v2"
engram search "OAuth login 403 error"
engram log   # see recent session activity
```

**What makes it different from CLAUDE.md memory files:**

CLAUDE.md is great for static instructions. But it's a flat file -- no semantic search, no conversation history, no cross-project memory. Engram stores the full conversation as a conversation (not extracted bullet points) and retrieves the relevant chunks by meaning when the agent needs them.

**Key details:**
- MCP-native -- works with Claude Code, Claude Desktop, Cursor, Windsurf, Zed
- Verbatim storage -- no summarization, no lossy extraction
- Semantic search powered by vector embeddings
- Free tier available, the SDK and CLI are MIT licensed
- Self-hostable on Cloudflare (free tier covers it)

Website: https://getengram.app
GitHub: https://github.com/get-engram/engram

Happy to answer questions about the setup or architecture.
