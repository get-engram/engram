# ChatGPT Integration Guide

Connect Engram to ChatGPT as a custom MCP connector. ChatGPT authenticates via
**OAuth**, and Engram is a full OAuth 2.1 authorization server, so you sign in
with your Engram account once and ChatGPT stays connected — no API key to paste.

## Add the connector

> Requires a paid ChatGPT tier (Plus/Pro/Business/Enterprise). Developer-mode
> custom connectors vary by tier and region.

1. **Settings → Apps & Connectors → Advanced settings → enable Developer mode.**
2. Back on the Connectors page, choose **Create / Add custom connector**.
3. **MCP Server URL:** `https://mcp.getengram.app/mcp`
4. **Authentication:** choose **OAuth**. ChatGPT discovers Engram's authorization
   server automatically (no client ID/secret to enter).
5. Click **Connect**. A getengram.app window opens — **sign in** and **Authorize**.
6. ChatGPT returns to the connector and Engram's tools appear. Done.

That's it. ChatGPT now has `search`, `create_conversation`, `append_messages`,
and the rest of Engram's tools.

> **Not the Apps directory.** The **Apps** entry in the ChatGPT sidebar is a
> curated, publish-only store — Engram is not a published ChatGPT app and won't
> appear there. Custom connectors (above) are the path for connecting Engram.

## How the OAuth flow works

You don't need to know this to use it, but for the curious:

1. ChatGPT calls `/mcp`, gets a `401` with a `WWW-Authenticate` pointer to
   Engram's resource metadata (RFC 9728).
2. It reads Engram's authorization-server metadata (RFC 8414) and
   **registers itself** automatically (Dynamic Client Registration, RFC 7591).
3. It opens Engram's `/oauth/authorize` with **PKCE**; you sign in on
   getengram.app and approve the consent screen.
4. ChatGPT exchanges the authorization code at `/oauth/token` for a short-lived
   access token (and a refresh token it rotates automatically).
5. It calls `/mcp` with the access token. Tokens map to your Engram org exactly
   like an API key.

Access is scoped to your account. You can revoke a connected app anytime from
your [dashboard](https://getengram.app/dashboard).

## Auto-memory in ChatGPT

To make ChatGPT use Engram automatically, add memory instructions to a
**Project** (Settings → Projects) or a Custom GPT's instructions:

```
At the start of a conversation, call Engram's `search` tool with a summary of
my request to recall relevant prior context.

When we make a decision or establish something worth remembering, store it with
`create_conversation` + `append_messages`.

Store: preferences, decisions and their reasoning, important facts.
Don't store: greetings or trivial, temporary details.
```

## Other clients

Engram works the same across every MCP-native client — memories stored in one
are searchable from the others:

| Client | Best for |
|--------|----------|
| [Claude Desktop](./claude-desktop.md) | General conversations, research, personal use |
| [Claude Code](./claude-code.md) | CLI-based coding and engineering |
| [Cursor](./cursor.md) | IDE-based coding |
| [Windsurf](./windsurf.md) | IDE-based coding with Cascade flows |
| [Codex CLI](./codex.md) | CLI-based coding with OpenAI models |

These use a Bearer API key directly; ChatGPT uses the OAuth flow above. Either
way it's the same memory.

## Troubleshooting

- **No "OAuth" option / can't add a connector.** Developer-mode custom connectors
  require a paid tier and aren't available in every region yet.
- **Login window doesn't return to ChatGPT.** Make sure pop-ups for chatgpt.com
  are allowed, then retry **Connect**.
- **Tools don't appear after authorizing.** Remove and re-add the connector; on
  re-add, ChatGPT re-runs discovery.
