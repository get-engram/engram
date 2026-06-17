# Engram

**Memory infrastructure for AI agents.** Store every conversation verbatim. Search by meaning.

[![Website](https://img.shields.io/badge/website-getengram.app-blue)](https://getengram.app)
[![Docs](https://img.shields.io/badge/docs-getengram.app%2Fdocs-blue)](https://getengram.app/docs/getting-started)
[![License](https://img.shields.io/badge/license-BSL--1.1-green)](LICENSE)

Engram is an MCP-native memory server that stores complete, uncompressed conversation transcripts and makes them searchable via semantic search. Connect any MCP-compatible client — Claude Desktop, Claude Code, Cursor, Windsurf, Zed — and your agent remembers everything across sessions.

## Quick start

1. **Sign up** at [getengram.app](https://getengram.app/signup) and get your API key
2. **Add to your MCP config** (Claude Desktop, Claude Code, Cursor, etc.):

```json
{
  "mcpServers": {
    "engram": {
      "command": "npx",
      "args": ["-y", "@getengram/cli@latest", "mcp"],
      "env": {
        "ENGRAM_API_KEY": "engram_sk_live_..."
      }
    }
  }
}
```

3. **Start using it.** Your agent now has persistent memory.

## How it works

- **Verbatim storage** — every message stored exactly as sent, no summarization or compression
- **Semantic search** — find relevant context by meaning using bge-base-en-v1.5 embeddings
- **MCP-native** — speaks the Model Context Protocol natively, works with any compatible client
- **Multi-tenant** — per-organization isolation, team seats, and API key management

## Architecture

Runs entirely on Cloudflare's developer platform:

- **Workers** — Hono.js API and MCP server
- **D1** — SQLite at the edge for messages and metadata
- **Vectorize** — semantic search index
- **Workers AI** — embedding generation

Read the full [architecture deep-dive](https://getengram.app/docs/architecture).

## MCP tools

Engram exposes 6 tools via MCP:

| Tool | Description |
|------|-------------|
| `create_conversation` | Start a new conversation with optional title, tags, metadata |
| `append_messages` | Add messages to an existing conversation |
| `search` | Semantic search across all conversations |
| `get_conversation` | Retrieve a conversation with its messages |
| `list_conversations` | List conversations with filtering and pagination |
| `delete_conversation` | Remove a conversation and its data |

See the [API reference](https://getengram.app/docs/api-reference) for full parameters and examples.

## Packages

| Package | Description |
|---------|-------------|
| [`apps/mcp-server`](apps/mcp-server) | Cloudflare Worker — MCP server and REST API |
| [`apps/cli`](apps/cli) | CLI and MCP bridge (`@getengram/cli`) |
| [`packages/sdk`](packages/sdk) | TypeScript SDK (`@getengram/sdk`) |
| [`packages/db`](packages/db) | Database queries and migrations |
| [`packages/shared`](packages/shared) | Shared constants, types, and utilities |

## Integration guides

- [Claude Desktop](https://getengram.app/docs/guides/claude-desktop)
- [Claude Code](https://getengram.app/docs/guides/claude-code)
- [Cursor](https://getengram.app/docs/guides/cursor)
- [Windsurf](https://getengram.app/docs/guides/windsurf)
- [OpenAI Codex CLI](https://getengram.app/docs/guides/codex)
- [Custom agents](https://getengram.app/docs/guides/custom-agents)

## Pricing

| Plan | Price | Messages/month |
|------|-------|----------------|
| Free | $0 | 1,000 |
| Pro | $39/mo | 100,000 |
| Team | $49/seat/mo | 500,000 |
| Enterprise | Custom | Unlimited |

[View pricing](https://getengram.app/pricing)

## Links

- **Website**: [getengram.app](https://getengram.app)
- **Documentation**: [getengram.app/docs](https://getengram.app/docs/getting-started)
- **Blog**: [getengram.app/blog](https://getengram.app/blog)
- **npm**: [@getengram/cli](https://www.npmjs.com/package/@getengram/cli)

## License

Business Source License 1.1 — see [LICENSE](LICENSE) for details.
