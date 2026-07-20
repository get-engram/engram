# ChatGPT Integration Guide

Connect Engram to ChatGPT as an **app / MCP connector**. ChatGPT authenticates via
**OAuth**, and Engram is a full OAuth 2.1 authorization server, so you sign in
with your Engram account once and ChatGPT stays connected — no API key to paste.

Once connected, memories saved in ChatGPT are searchable from Claude, Cursor, and
every other connected tool — one shared memory across all of them.

## Add Engram

### Option A — Install the Engram plugin (recommended)

1. In ChatGPT, open the **Plugin directory** (OpenAI migrated the app directory to plugins in July 2026).
2. Search for **Engram** and install it.
3. Sign in with your Engram account (OAuth) and authorize. Engram's tools appear.

### Option B — Developer-mode custom connector

> Developer-mode custom connectors vary by tier and region — try Option A first.

1. **Settings → Apps & Connectors → Advanced settings → enable Developer mode.**
2. Back on the Connectors page, choose **Create / Add custom connector**.
3. **MCP Server URL:** `https://mcp.getengram.app/mcp`
4. **Authentication:** choose **OAuth**. ChatGPT discovers Engram's authorization
   server automatically (no client ID/secret to enter).
5. Click **Connect**. A getengram.app window opens — **sign in** and **Authorize**.
6. ChatGPT returns to the connector and Engram's tools appear. Done.

Either way, ChatGPT now has `search`, `create_conversation`, `append_messages`,
and the rest of the memory tools.

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

## How memory capture works in ChatGPT

Unlike Claude Code or Cursor — which run on your machine and let Engram capture
every message automatically — **ChatGPT is a hosted app with no background capture
hook.** By OpenAI's design and app-store policy, no connector can silently record
your entire conversation. So in ChatGPT, Engram works two complementary ways.

### 1. Save on request — "remember this"

Tell ChatGPT to remember something and it's stored in Engram verbatim, then
searchable from every connected tool:

- *"Save this decision to Engram."*
- *"Remember that we're using Postgres for the billing service."*

To make this proactive, add memory instructions to a **Project**
(Settings → Projects) or a Custom GPT's instructions:

```
At the start of a conversation, call Engram's `search` tool with a summary of
my request to recall relevant prior context.

When we make a decision or establish something worth remembering, store it with
`create_conversation` + `append_messages`.

Store: preferences, decisions and their reasoning, important facts.
Don't store: greetings or trivial, temporary details.
```

ChatGPT honors this on a best-effort basis — it decides when to call tools —
which is reliable for the things you explicitly want kept.

### 2. Import your full history — one time

To bring **everything you've already said in ChatGPT** into Engram, use the
native export:

1. **Request the export** — on the web: **Settings → Data Controls → Export
   data**; in the desktop app: **Settings → Account → Data Controls → Export
   data**. OpenAI emails you a link; unzip it to find `conversations.json`.
2. Import it — easiest via the [dashboard](https://getengram.app/dashboard)
   (find **Import your history** → **Upload** → select the file), or the CLI:

   ```bash
   export ENGRAM_API_KEY=engram_sk_live_...
   npx @getengram/cli import ~/Downloads/chatgpt-export/conversations.json --dry-run  # preview
   npx @getengram/cli import ~/Downloads/chatgpt-export/conversations.json            # import
   ```

Either way, every conversation is stored verbatim, tagged `chatgpt-import`, and
embedded for search.

> **Note:** the native export is available on ChatGPT Free / Plus / Pro / eligible
> Edu plans, can take up to 7 days to arrive (link expires 24h after delivery),
> and is not currently available for ChatGPT Business / Enterprise workspaces.

### What ChatGPT can't do (and no app can)

Engram can't silently auto-record every ChatGPT message in the background the way
it does for Claude Code and Cursor — there's no per-message hook for connectors,
and OpenAI's policy prohibits pulling your full chat log. The honest, complete
story is: **save what matters on request + import your history in bulk**, and get
automatic verbatim capture in the local tools that support it.

## Other clients

Engram works across every MCP-native client — memories stored in one are
searchable from the others:

| Client | Capture |
|--------|---------|
| [Claude Code](./claude-code.md) | Automatic, verbatim (local) |
| [Cursor](./cursor.md) | Automatic, verbatim (local) |
| [Claude Desktop](./claude-desktop.md) | On request (MCP) |
| ChatGPT | On request + bulk import |
| [Windsurf](./windsurf.md) | On request (MCP) |
| [Codex CLI](./codex.md) | On request (MCP) |

## Troubleshooting

- **No "OAuth" option / can't add a connector.** Developer-mode custom connectors
  require a paid tier and aren't available in every region yet — try Option A.
- **Login window doesn't return to ChatGPT.** Make sure pop-ups for chatgpt.com
  are allowed, then retry **Connect**.
- **Tools don't appear after authorizing.** Remove and re-add the connector; on
  re-add, ChatGPT re-runs discovery.
- **A tool call was "blocked."** ChatGPT's safety layer can refuse broad requests
  like "save my entire history" before they reach Engram. Ask it to save the
  current exchange ("remember this"), or use the import path above for bulk history.
