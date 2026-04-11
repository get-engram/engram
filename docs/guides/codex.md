# OpenAI Codex CLI Integration Guide

Give OpenAI's Codex CLI persistent memory across sessions using Engram.

## Setup

### 1. Get an API Key

Sign up at [getengram.app](https://getengram.app) or [self-host](../self-hosting.md) your own instance.

### 2. Add the MCP Server

Codex CLI supports MCP servers. Add Engram to your Codex configuration:

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

Start a Codex session and ask it to search Engram. If it calls the `search` tool successfully, you're connected.

---

## Automatic Memory

Codex CLI uses `AGENTS.md` for project-level instructions — similar to Claude Code's `CLAUDE.md`. This file is loaded into context at the start of every session.

### Add Memory Instructions to AGENTS.md

Create `AGENTS.md` in your project root:

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
      agent_id: "codex"
      tags: ["<project-name>", "<topic>"]
      metadata: { "project": "<project-name>" }

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

- Routine file reads or searches
- Trivial exchanges ("hello", "thanks")
- Information already in the codebase or git history
```

---

## Example: Memory in Action

**Session 1:**

```
You: Refactor the payment module to use Stripe's new v2 API.
     Make sure we keep the webhook signature verification.

Codex: [searches Engram — no prior context]
Codex: I'll refactor the payment module from Stripe v1 to v2...
Codex: [stores in Engram:
  title: "Stripe v1 → v2 migration for payment module"
  tags: ["payments", "migration", "stripe"]
  messages: migration approach, webhook verification requirement]
```

**Session 2:**

```
You: Add subscription management to the payment module.

Codex: [searches Engram → finds Stripe migration context]
Codex: I see we recently migrated to Stripe's v2 API. I'll implement
       subscription management using the v2 Subscriptions API,
       consistent with the existing payment module patterns...
```

---

## Codex Autonomous Mode

Codex CLI can run in autonomous modes (suggest, auto-edit, full-auto). Engram works across all modes — the agent searches and stores memory regardless of how much autonomy it has.

In `full-auto` mode, Codex can:
1. Search Engram for prior context at session start
2. Make decisions informed by that context
3. Store what it did for future sessions

This is especially powerful for repeated tasks — Codex learns from prior sessions what approach to take, what patterns to follow, and what to avoid.

---

## AGENTS.md vs. CLAUDE.md

If your project uses both Codex and Claude Code, you'll have both `AGENTS.md` and `CLAUDE.md`. The memory instructions can be identical — just change the `agent_id`:

| File | Agent | `agent_id` |
|------|-------|-----------|
| `AGENTS.md` | Codex CLI | `"codex"` |
| `CLAUDE.md` | Claude Code | `"claude-code"` |

Both agents read from and write to the same Engram memory. A decision stored by Codex is found by Claude Code, and vice versa.

---

## Tips

- **Use `agent_id: "codex"`** to distinguish Codex memories from other tools.
- **Same API key = shared memory.** Codex, Claude Code, Cursor — all contribute to the same knowledge base.
- **Commit `AGENTS.md`** so your team gets auto-memory behavior automatically.
- **Full-auto mode + memory** is particularly powerful — Codex can operate autonomously while building on context from prior sessions.
