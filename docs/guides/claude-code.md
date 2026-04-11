# Claude Code Integration Guide

Give Claude Code persistent memory across sessions using Engram.

## Setup

### 1. Get an API Key

Sign up at [getengram.app](https://getengram.app) or [self-host](../self-hosting.md) your own instance.

### 2. Add the MCP Server

**Global (all projects)** — add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "engram": {
      "type": "url",
      "url": "https://mcp.getengram.app/mcp",
      "headers": {
        "Authorization": "Bearer engram_sk_live_your_key_here"
      }
    }
  }
}
```

**Per-project** — add `.mcp.json` to the project root:

```json
{
  "mcpServers": {
    "engram": {
      "type": "url",
      "url": "https://mcp.getengram.app/mcp",
      "headers": {
        "Authorization": "Bearer engram_sk_live_your_key_here"
      }
    }
  }
}
```

### 3. Verify Connection

Start a Claude Code session and ask:

```
Search Engram for "test"
```

If you see search results (or an empty results array), Engram is connected.

---

## Automatic Memory

The real power is auto-memory — Claude Code stores and recalls context without you telling it to. This is configured through `CLAUDE.md`, the project instruction file that Claude Code loads automatically at the start of every session.

### Add Memory Instructions to CLAUDE.md

Add this block to your project's `CLAUDE.md`:

```markdown
## Engram Memory

You have access to Engram as an MCP server. Use it to maintain persistent memory across sessions.

### On session start

Search Engram for context relevant to the current task:

    search
      query: "<summary of what the user is asking about>"
      limit: 5

Include any relevant results in your working context — they contain prior conversations about this project, decisions made, bugs investigated, and user preferences.

### During the session

When significant work is done or important context is established, store it:

    create_conversation
      title: "<concise description of what was discussed>"
      agent_id: "claude-code"
      tags: ["<project-name>", "<topic>"]
      metadata: { "project": "<project-name>", "branch": "<current branch if relevant>" }

    append_messages
      conversation_id: "<the conversation ID>"
      messages:
        - role: "user"
          content: "<what the user asked>"
        - role: "assistant"
          content: "<what you did and why>"

### What to store

- Decisions and their reasoning ("we chose X because Y")
- Bug investigations and resolutions
- User preferences and workflow patterns
- Architecture discussions
- Anything you'd want to remember next session

### What NOT to store

- Routine file reads or searches (these are in git)
- Trivial exchanges ("hello", "thanks")
- Information already in the codebase or git history
```

### How It Works

1. Claude Code loads `CLAUDE.md` at the start of every session
2. The memory instructions tell it to search Engram for relevant context
3. During the session, it stores important decisions and context
4. Next session, it finds that context via semantic search

No manual intervention needed. The agent just remembers.

---

## Example: Memory in Action

**Session 1 (Monday):**

```
You: Let's use Postgres instead of MySQL for the new service.
     The JSONB support is better for the catalog schema.

Claude Code: [searches Engram — no prior context]
Claude Code: I'll set up Postgres. Creating the schema now...
Claude Code: [stores in Engram:
  title: "Database choice for new service"
  tags: ["architecture", "database"]
  messages: decision to use Postgres over MySQL, reasoning about JSONB]
```

**Session 2 (Thursday):**

```
You: Set up the database for the new service.

Claude Code: [searches Engram → finds Monday's conversation]
Claude Code: Setting up Postgres — we decided on Monday to use it instead
             of MySQL because of the JSONB support for the catalog schema.
             Creating the migrations now...
```

No re-explaining. No lost context. The agent just knows.

---

## Tips

- **Use descriptive tags.** Tags like `["auth", "bugfix"]` or `["architecture", "database"]` make it easier to find relevant context later.
- **One CLAUDE.md per project.** Each project can have its own memory instructions with project-specific tags and metadata.
- **Share across a team.** If your team uses the same Engram API key, everyone's Claude Code sessions contribute to shared organizational memory. A decision made by one developer is recalled by another's agent.
- **Use `agent_id: "claude-code"`** to distinguish Claude Code memories from memories created by other tools (Cursor, Claude Desktop, etc.).

---

## Shared Memory Across Tools

If you use the same Engram API key in Claude Code and other tools (Claude Desktop, Cursor, etc.), all of them read from and write to the same memory. A bug investigated in Claude Code can be recalled by Cursor. An architecture decision made in Claude Desktop informs Claude Code.

See the other integration guides for setting up additional tools with the same API key.
