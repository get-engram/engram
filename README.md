# Engram

**One memory for all your AI apps.** Engram keeps your AI conversations word for word and makes them searchable from ChatGPT, Claude, Cursor, and any other app that speaks MCP.

[![Website](https://img.shields.io/badge/website-getengram.app-blue)](https://getengram.app)
[![Docs](https://img.shields.io/badge/docs-getengram.app%2Fdocs-blue)](https://getengram.app/docs/getting-started)
[![License](https://img.shields.io/badge/license-BSL--1.1-green)](LICENSE)

Every AI app keeps its own history, and none of them can see the others'. Open a new chat, or move from ChatGPT to Claude, and you explain yourself again from the beginning. Engram sits outside all of them. Say "remember this" in one app, ask about it in another, and the original words come back.

- **Word for word.** Conversations are stored as they were written, never summarized or reworded. Recognized secrets and personal details are redacted before saving.
- **Found by meaning.** Ask in your own words. You do not need to remember the exact phrase.
- **Permanent, and yours.** Memory never expires on any plan, and you can export or delete your conversations whenever you want.

## Get started

Signing in for the first time creates a free account. There is no card to enter.

### Claude — web, desktop and mobile

Engram is in Claude's connector directory: **[claude.ai/directory/engram](https://claude.ai/directory/engram)**

Open the listing, press **Connect**, and sign in. You connect once, and Engram is then available in Claude on the web, in the desktop app, and in the mobile apps.

### ChatGPT

Engram is in ChatGPT's Plugin directory. Open the directory in ChatGPT, search for **Engram**, install it, and sign in. The [ChatGPT guide](https://getengram.app/docs/guides/chatgpt) explains how saving works there.

Sign in to the same Engram account in ChatGPT and in Claude and they share one memory: what you saved from one, the other can find.

### Claude Code

```
/plugin marketplace add get-engram/engram
/plugin install engram@engram
```

Restart Claude Code and approve access in the browser. The plugin also ships a skill that tells Claude when to search memory and what is worth saving, so context builds up without being asked.

### Cursor, Windsurf, VS Code, and any other MCP client

Point the client at the remote server and let OAuth handle access:

```json
{
  "mcpServers": {
    "engram": {
      "type": "http",
      "url": "https://mcp.getengram.app/mcp"
    }
  }
}
```

There is no API key to copy. The server implements the MCP authorization flow (RFC 9728 / 8414 / 7591, PKCE), so the client discovers it, registers itself, and signs you in.

For a client that only speaks stdio, bridge to the remote server with [mcp-remote](https://www.npmjs.com/package/mcp-remote). It drives the same browser sign-in:

```json
{
  "mcpServers": {
    "engram": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.getengram.app/mcp"]
    }
  }
}
```

### Bring the conversations you already have

Years of history are sitting in ChatGPT and Claude. Export it once and Engram makes all of it searchable from every app:

- **In the browser** — follow [Import your ChatGPT history](https://getengram.app/chatgpt/import). You upload the export file from your dashboard; no terminal needed.
- **From a terminal** — `npx @getengram/cli import conversations.json --dry-run` previews the import, and the same command without `--dry-run` runs it. ChatGPT and Claude exports are both supported. See [docs/guides/import-chatgpt.md](docs/guides/import-chatgpt.md).

## Setup guides

[ChatGPT](https://getengram.app/docs/guides/chatgpt) ·
[Claude Desktop](https://getengram.app/docs/guides/claude-desktop) ·
[Claude Code](https://getengram.app/docs/guides/claude-code) ·
[Cursor](https://getengram.app/docs/guides/cursor) ·
[Windsurf](https://getengram.app/docs/guides/windsurf) ·
[VS Code](https://getengram.app/docs/guides/vscode) ·
[JetBrains](https://getengram.app/docs/guides/jetbrains) ·
[Zed](https://getengram.app/docs/guides/zed) ·
[Cline](https://getengram.app/docs/guides/cline) ·
[Goose](https://getengram.app/docs/guides/goose) ·
[OpenAI Codex CLI](https://getengram.app/docs/guides/codex) ·
[Gemini CLI](https://getengram.app/docs/guides/gemini-cli) ·
[Custom agents](https://getengram.app/docs/guides/custom-agents)

## How it works

- **Verbatim storage** — every message is kept as written, with no summarization or compression. Recognized secrets and personal details are [redacted on the way in](https://getengram.app/docs/secret-redaction).
- **Search** — messages are split into chunks and embedded with bge-base-en-v1.5, and also indexed for keyword search. A query runs both and fuses the two result lists into one ranking.
- **MCP-native** — a remote MCP server with OAuth sign-in. A REST API, a CLI, and a TypeScript SDK cover everything else.
- **Multi-tenant** — per-organization isolation, team seats that share one memory, and API key management.

## MCP tools

Engram exposes 8 core tools via MCP:

| Tool | Description |
|------|-------------|
| `create_conversation` | Start a new conversation with optional title, tags, metadata |
| `append_messages` | Add messages to an existing conversation |
| `search` | Search across all conversations |
| `get_conversation` | Retrieve a conversation with its messages |
| `list_conversations` | List conversations with filtering and pagination |
| `delete_conversation` | Remove a conversation and its data |
| `memory_status` | Show how much of the plan's storage is used |
| `whoami` | Show which Engram account the connection is using |

Connections that use an API key also get the secrets vault tools (`resolve_vault`, `vault_set`, `vault_get`, `vault_list`, `vault_delete`) and `manage_subscription`. See the [API reference](https://getengram.app/docs/api-reference) for full parameters and examples.

## REST API, CLI, and SDK

- **REST API** — `https://mcp.getengram.app/api/v1`, authenticated with an API key from your dashboard. See the [API reference](https://getengram.app/docs/api-reference).
- **CLI** — `brew install get-engram/engram/engram` or `npm install -g @getengram/cli`. Store, search, and import from a terminal. See the [CLI reference](https://getengram.app/docs/cli).
- **TypeScript SDK** — `npm install @getengram/sdk`. See the [SDK reference](https://getengram.app/docs/sdk).
- **Secrets vault** — a separate store for passwords and API keys. Values are encrypted on your machine before upload, so the server never sees them. See [docs/vault.md](docs/vault.md).

## Architecture

Engram runs entirely on Cloudflare's developer platform:

- **Workers** — the MCP server and REST API (Hono.js)
- **D1** — conversation and message metadata, accounts, and the keyword index
- **R2** — the stored text of messages and search chunks
- **Vectorize** — the semantic search index
- **Workers AI** — embedding generation
- **Durable Objects and Cron Triggers** — background maintenance

Read the full [architecture deep-dive](https://getengram.app/docs/architecture).

## Repository layout

| Path | What it is |
|------|------------|
| [`apps/mcp-server`](apps/mcp-server) | Cloudflare Worker — MCP server and REST API |
| [`apps/cli`](apps/cli) | The `engram` command line tool (`@getengram/cli`) |
| [`packages/sdk`](packages/sdk) | TypeScript SDK (`@getengram/sdk`) |
| [`packages/db`](packages/db) | Database migrations and queries |
| [`packages/shared`](packages/shared) | Shared constants, types, and utilities |
| [`plugins/engram`](plugins/engram) | Claude Code plugin |
| [`mcpb`](mcpb) | Claude Desktop extension bundle |
| [`docs`](docs) | Developer documentation that is not on the website |

## Development

```bash
pnpm install        # install dependencies
pnpm build          # build all packages
pnpm test           # run all tests
pnpm typecheck      # type check
```

See [docs/contributing.md](docs/contributing.md) for the workflow and for running the server locally. To report a security problem, follow [docs/security.md](docs/security.md).

## Pricing

Memory is permanent. The limits below are how many messages a plan can hold, not a monthly quota: nothing expires, and deleting conversations frees space.

| Plan | Price | Memory |
|------|-------|--------|
| Free | $0 | 10,000 messages |
| Pro | $9/mo | 1,000,000 messages |
| Team | $9/seat/mo, minimum 2 seats | 1,000,000 messages per seat, pooled |
| Education | $3/mo per student, $3/seat/mo for academic teams (minimum 2 seats) | Pro or Team features with a verified university email |
| Enterprise | Custom | Unlimited |

The [pricing page](https://getengram.app/pricing) is the source of truth for prices and for what each plan includes.

## Links

- **Website**: [getengram.app](https://getengram.app)
- **Documentation**: [getengram.app/docs](https://getengram.app/docs/getting-started)
- **Blog**: [getengram.app/blog](https://getengram.app/blog)
- **Claude directory**: [claude.ai/directory/engram](https://claude.ai/directory/engram)
- **npm**: [@getengram/cli](https://www.npmjs.com/package/@getengram/cli), [@getengram/sdk](https://www.npmjs.com/package/@getengram/sdk)

## License

Business Source License 1.1. In short: you can read the code, self-host it for your own internal use, and integrate with the hosted service; you may not offer it to others as a commercial hosted or managed memory service. On May 14, 2030 the license changes to Apache 2.0. The SDK in `packages/sdk` is licensed separately under the Mozilla Public License 2.0. [LICENSE](LICENSE) has the exact terms and is what applies.
