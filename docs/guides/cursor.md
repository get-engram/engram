# Cursor Integration Guide

Give Cursor persistent memory across sessions using Engram.

## Setup

### 1. Get an API Key

Sign up at [getengram.app](https://getengram.app) or [self-host](../self-hosting.md) your own instance.

### 2. Add the MCP Server

**Option A: Cursor Settings UI**

1. Open Cursor Settings (`Cmd+,` / `Ctrl+,`)
2. Navigate to **MCP** (or search "MCP")
3. Click **Add new MCP server**
4. Enter:
   - **Name:** `engram`
   - **Type:** `http`
   - **URL:** `https://mcp.getengram.app/mcp`
   - **Headers:** `Authorization: Bearer engram_sk_live_your_key_here`

**Option B: Project config file**

Create `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "engram": {
      "type": "http",
      "url": "https://mcp.getengram.app/mcp",
      "headers": {
        "Authorization": "Bearer engram_sk_live_your_key_here"
      }
    }
  }
}
```

### 3. Verify

Open Cursor's agent mode (Composer with Agent) and ask it to search Engram. If it can call the `search` tool, you're connected.

---

## Automatic Memory

Cursor uses `.cursorrules` (or `.cursor/rules`) for project-level instructions that are loaded into every agent session.

### Add Memory Instructions to .cursorrules

Create `.cursorrules` in your project root:

```
## Engram Memory

You have access to Engram memory tools via MCP. Use them automatically.

### On session start

Search Engram for context relevant to the current task:

  search
    query: "<summary of what the user is asking about>"
    limit: 5

Include relevant results in your working context.

### During the session

Store important context:

  create_conversation
    title: "<concise description>"
    agent_id: "cursor"
    tags: ["<project-name>", "<topic>"]

  append_messages
    conversation_id: "<id>"
    messages:
      - role: "user"
        content: "<what the user asked>"
      - role: "assistant"
        content: "<what you did and why>"

### What to store

- Decisions and their reasoning
- Bug investigations and resolutions
- User preferences and coding style
- Architecture discussions

### What NOT to store

- Routine code generation
- File reads and searches
- Information already in git
```

---

## Example: Memory in Action

**Session 1:**

```
You: We need to add rate limiting to the API. Use a sliding window
     algorithm with Redis, not the token bucket approach.

Cursor: [searches Engram — no prior context for this]
Cursor: I'll implement sliding window rate limiting with Redis...
Cursor: [stores in Engram:
  title: "Rate limiting: sliding window with Redis"
  tags: ["api", "rate-limiting", "architecture"]
  messages: decision to use sliding window over token bucket, Redis as backend]
```

**Session 2 (next week):**

```
You: Add rate limiting to the new /upload endpoint.

Cursor: [searches Engram → finds rate limiting decision]
Cursor: I'll add sliding window rate limiting using Redis, consistent
        with the approach we chose for the other API endpoints.
        Implementing now...
```

---

## Agent Mode vs. Chat Mode

Engram works best with **Agent mode** (Composer with Agent enabled), where Cursor can autonomously call MCP tools. In regular Chat mode, Cursor may not call MCP tools automatically.

To use Agent mode:
1. Open Composer (`Cmd+I` / `Ctrl+I`)
2. Ensure "Agent" is selected (not "Chat" or "Edit")
3. The agent can now call Engram tools automatically

---

## Tips

- **Agent mode is required** for automatic MCP tool usage. Chat mode won't trigger auto-memory.
- **Use `.cursor/mcp.json`** for per-project setup. This keeps the MCP config in the repo so your team shares it.
- **Commit `.cursorrules`** so everyone on the team gets auto-memory behavior.
- **Combine with Claude Code.** Same API key = shared memory. Debug in Cursor, recall context in Claude Code.
