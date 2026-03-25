# Getting Started

Engram is a memory service for AI agents. It stores complete, uncompressed conversation transcripts and makes them searchable via semantic search. Connect any MCP-compatible client and your agent remembers everything.

## Why Engram?

Every existing memory product (Mem0, Zep, Supermemory) compresses conversations into extracted "memories." Details get lost. Context disappears.

Engram takes a different approach: **the conversation IS the knowledge base.** Every message, tool call, and response is stored verbatim. When you search, you get back the actual conversation — not a summary of it.

## Quick Start

### 1. Connect to Engram

Add Engram to your MCP client configuration. For Claude Desktop, add to your `claude_desktop_config.json`:

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

### 2. Store a Conversation

```
create_conversation
  title: "Debugging the auth flow"
  tags: ["engineering", "auth"]
```

Returns: `{ "conversation_id": "conv_abc123..." }`

### 3. Append Messages

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

### 4. Search Later

```
search
  query: "OAuth login 403 error"
```

Returns the matching conversation chunks with relevance scores and the original messages.

## Concepts

- **Conversations** — A container for messages. Has a title, optional tags, and metadata.
- **Messages** — Verbatim records of what was said. Roles: `user`, `assistant`, `system`, `tool`.
- **Chunks** — Sliding windows of messages, automatically created and embedded for search.
- **Organizations** — Tenant isolation. Each API key belongs to one org. Data never leaks across orgs.

## Next Steps

- [API Reference](./api-reference.md) — All 6 MCP tools with parameters and examples
- [Authentication](./authentication.md) — API key format and setup
- [Concepts](./concepts.md) — How storage and search work under the hood
- [Self-Hosting](./self-hosting.md) — Deploy your own Engram instance on Cloudflare
