# Getting Started

Engram is a memory service for AI agents. It stores complete, uncompressed conversation transcripts and makes them searchable via semantic search. Connect any MCP-compatible client and your agent remembers everything.

## Why Engram?

Every existing memory product (Mem0, Zep, Supermemory) compresses conversations into extracted "memories." Details get lost. Context disappears.

Engram takes a different approach: **the conversation IS the knowledge base.** Every message, tool call, and response is stored verbatim. When you search, you get back the actual conversation — not a summary of it.

## Quick Start

### 1. Get an API Key

Sign up at [getengram.app](https://getengram.app) or [self-host](./self-hosting.md) your own instance.

Your API key looks like: `engram_sk_live_aBcDeFgHiJkLmNoPqRsTuVwXyZaBcDeF`

### 2. Connect to Engram

Add Engram to your MCP client. See [Integrations](./integrations.md) for all supported clients.

**Claude Code:**

Add to `~/.claude/settings.json` under `mcpServers`:

```json
{
  "engram": {
    "type": "http",
    "url": "https://mcp.getengram.app/mcp",
    "headers": {
      "Authorization": "Bearer engram_sk_live_your_api_key_here"
    }
  }
}
```

**Claude Desktop:**

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "engram": {
      "url": "https://mcp.getengram.app/mcp",
      "headers": {
        "Authorization": "Bearer engram_sk_live_your_api_key_here"
      }
    }
  }
}
```

### 3. Store a Conversation

```
create_conversation
  title: "Debugging the auth flow"
  tags: ["engineering", "auth"]
```

Returns: `{ "conversation_id": "conv_abc123..." }`

### 4. Append Messages

```
append_messages
  conversation_id: "conv_abc123..."
  messages:
    - role: "user"
      content: "The login page returns a 403 after the OAuth redirect"
    - role: "assistant"
      content: "That's likely a CSRF token mismatch. Check if the state parameter..."
```

Messages are stored verbatim and automatically indexed for semantic search.

### 5. Search Later

```
search
  query: "OAuth login 403 error"
```

Returns the matching conversation chunks with relevance scores and the original messages.

---

## Automatic Memory (Recommended)

The real power of Engram is when your agent stores and recalls memory **automatically** — without you having to tell it to.

### How it works

1. **On session start** — The agent searches Engram for prior context relevant to your first message
2. **During the session** — Important decisions, investigations, and context are stored
3. **Next session** — The agent already knows what happened before

### Setup for Claude Code

Add a `CLAUDE.md` file to your project root with these instructions:

```markdown
## Engram Memory

You have access to Engram as an MCP server. Use it to maintain persistent memory.

### On session start

Search Engram for context relevant to the current task:

    search
      query: "<summary of what the user is asking about>"
      limit: 5

Include relevant results in your working context.

### During the session

When important work is done, store it:

    create_conversation
      title: "<what was discussed>"
      agent_id: "claude-code"
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
- User preferences and workflow
- Architecture discussions
```

### Setup for Claude Desktop

Add to your system prompt or project instructions:

```
You have access to Engram memory tools. At the start of each conversation,
search Engram for relevant prior context. When you learn something important
about the user or make a significant decision, store it in Engram so you
can recall it in future conversations.
```

### Setup for custom agents

In your agent's system prompt:

```
You have persistent memory via Engram. Before responding to the user:
1. Search Engram for relevant prior conversations
2. Use any relevant results to inform your response

After the conversation, store important context:
1. Create a conversation with a descriptive title and tags
2. Append the key messages from this session
```

### What gets remembered

| Store | Don't store |
|-------|-------------|
| Decisions and reasoning | Routine code searches |
| Bug investigations & fixes | "Hello" / "Thanks" |
| User preferences | Info already in git history |
| Architecture discussions | Temporary debugging output |
| Project context & goals | File contents (they're in the repo) |

### Example: Memory in action

**Session 1** (Monday):
```
User: "Let's use Postgres instead of MySQL for the new service"
Agent: [stores in Engram with tags: ["database", "architecture"]]
```

**Session 2** (Thursday):
```
User: "Set up the database for the new service"
Agent: [searches Engram → finds Monday's decision]
Agent: "Setting up Postgres — we decided on Monday to use it instead of MySQL
        because of the JSONB support for the catalog schema."
```

No re-explaining. No lost context. The agent just knows.

---

## Protecting Secrets

If your agents handle sensitive data (API keys, credentials, PII), enable the **Secrets Vault** for client-side encryption:

```bash
# Generate and save a vault key
engram vault keygen --save
```

Then configure the SDK:

```typescript
const engram = new Engram({
  apiKey: process.env.ENGRAM_API_KEY!,
  vault: { encryptionKey: process.env.ENGRAM_VAULT_KEY! },
})
```

Secrets in message content are automatically detected, encrypted on your machine, and replaced with `[VAULT:vlt_...]` tokens before being sent to Engram. The server never sees plaintext secrets.

See [Secrets Vault](./vault.md) for the full guide.

## Concepts

- **Conversations** — A container for messages. Has a title, optional tags, and metadata.
- **Messages** — Verbatim records of what was said. Roles: `user`, `assistant`, `system`, `tool`.
- **Chunks** — Sliding windows of messages, automatically created and embedded for search.
- **Vault** — Client-side secret encryption. Detects and encrypts sensitive data before it leaves your machine.
- **Organizations** — Tenant isolation. Each API key belongs to one org. Data never leaks across orgs.

## Next Steps

- [Secrets Vault](./vault.md) — Client-side encryption for sensitive data
- [API Reference](./api-reference.md) — All 7 MCP tools with parameters and examples
- [Integrations](./integrations.md) — Claude Desktop, Cursor, Windsurf, custom clients
- [Concepts](./concepts.md) — How storage and search work under the hood
- [Architecture](./architecture.md) — Deep dive into how everything works
- [Use Cases](./use-cases.md) — Agent memory, support history, knowledge bases
- [Self-Hosting](./self-hosting.md) — Deploy your own Engram instance on Cloudflare
