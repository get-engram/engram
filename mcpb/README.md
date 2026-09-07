# Engram — Claude Desktop extension

Persistent, searchable memory for Claude. Conversations are stored verbatim —
never summarized — and retrieved by meaning.

## Install

Download `engram.mcpb` and open it with Claude Desktop (or double-click it).
On first use Claude opens a browser window to sign in to Engram; approving it
creates a free account (10,000 messages, no expiry) if you don't have one.
There is no API key to copy and no configuration to edit.

## What Claude gets

- `search` — semantic search across everything you've stored
- `create_conversation` / `append_messages` — save conversations
- `get_conversation`, `list_conversations`, `delete_conversation`
- `memory_status` — your usage against your plan

The same memory is shared with every MCP client you connect — ChatGPT,
Cursor, Claude Code — so nothing is siloed in one tool.

## Privacy Policy

Engram stores the conversations you explicitly save, verbatim, to make them
searchable. We do not sell your data, we do not train models on your
conversation content, and connecting this extension gives Engram no access to
anything else in Claude. Full policy: https://getengram.app/privacy

- Data collection: conversations you save; account email; usage counters
- Storage: Cloudflare (R2/D1/Vectorize), US jurisdiction
- Sharing: subprocessors only (Cloudflare, Stripe, Supabase, Resend); no
  advertisers or brokers
- Retention: until you delete it; account deletion purges within 30 days
- Contact: hello@getengram.app

## License

The extension in this directory is MIT licensed (see LICENSE). The Engram
server it connects to is a separate hosted service; the wider repository
carries its own license.

## Build (maintainers)

```
cd mcpb && npm install
npx @anthropic-ai/mcpb pack
```
