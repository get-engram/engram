# Windsurf Integration Guide

Give Windsurf persistent memory across sessions using Engram.

## Setup

### 1. Get an API Key

Sign up at [getengram.app](https://getengram.app) or [self-host](../self-hosting.md) your own instance.

### 2. Add the MCP Server

Add to your Windsurf MCP configuration:

```json
{
  "mcpServers": {
    "engram": {
      "serverUrl": "https://mcp.getengram.app/mcp",
      "headers": {
        "Authorization": "Bearer engram_sk_live_your_key_here"
      }
    }
  }
}
```

### 3. Verify

Open a Windsurf Cascade session and ask it to search Engram. If the `search` tool is available, you're connected.

---

## Automatic Memory

Windsurf uses `.windsurfrules` for project-level instructions loaded into every Cascade session.

### Add Memory Instructions to .windsurfrules

Create `.windsurfrules` in your project root:

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
    agent_id: "windsurf"
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
You: Let's set up the project with Tailwind v4. Don't use the
     @apply directive — we had issues with it in the last project.

Windsurf: [stores in Engram:
  title: "CSS approach: Tailwind v4 without @apply"
  tags: ["frontend", "css", "preferences"]
  messages: use Tailwind v4, avoid @apply due to past issues]
```

**Session 2:**

```
You: Style the new dashboard component.

Windsurf: [searches Engram → finds CSS preferences]
Windsurf: I'll style this with Tailwind v4 utility classes directly,
          avoiding @apply per our earlier decision. Here's the component...
```

---

## Cascade Flows

Windsurf's Cascade feature executes multi-step flows. Engram works naturally with Cascade — the agent can search for context at the start of a flow and store results at the end.

For complex flows, consider storing the outcome:

```
create_conversation
  title: "Cascade: migrated auth to NextAuth v5"
  agent_id: "windsurf"
  tags: ["migration", "auth"]
  metadata: { "cascade_type": "migration" }

append_messages
  messages:
    - role: "user"
      content: "Migrate our auth from NextAuth v4 to v5"
    - role: "assistant"
      content: "Completed migration: updated 12 files, changed session handling from JWT to database strategy, updated all middleware..."
```

---

## Tips

- **Cascade flows benefit most** from memory — complex multi-step tasks build context that's valuable in future sessions.
- **Commit `.windsurfrules`** to share auto-memory behavior across your team.
- **Same API key = shared memory.** Use the same Engram key across Windsurf, Claude Code, Cursor, etc.
