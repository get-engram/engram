# ChatGPT Integration Guide

ChatGPT now supports custom MCP connectors, but connecting Engram has an
authentication caveat. This page documents the current state and your options.

## Current Status

ChatGPT exposes two surfaces for third‑party tools:

- **Apps directory** (Settings sidebar → **Apps**) — a *curated, publish‑only*
  store (Photoshop, booking apps, etc.). Engram is not a published ChatGPT app,
  so it will **not** appear here, and there is no "add your own" option on this page.
- **Custom connectors** (Settings → **Apps & Connectors** → **Advanced settings**
  → enable **Developer mode**) — lets you add an arbitrary MCP server by URL.

The custom‑connector path is the right one for Engram, **but** ChatGPT's connector
UI only offers **OAuth** or **No authentication**. Engram authenticates with a
static `Authorization: Bearer engram_sk_live_...` header, which ChatGPT does not
let you set. Until Engram ships OAuth (or a REST API for Custom GPT Actions),
ChatGPT cannot connect directly.

> Tracking: OAuth / REST support for ChatGPT is the gating work. See the
> [roadmap](../roadmap.md).

## What to try

### 1. Developer‑mode custom connector (try this first)

1. **Settings → Apps & Connectors → Advanced settings → enable Developer mode.**
2. Back on the Connectors page, choose **Create / Add custom connector**.
3. **MCP Server URL:** `https://mcp.getengram.app/mcp`
4. **Authentication:** if a custom‑header / API‑key option is offered, paste
   `Authorization: Bearer engram_sk_live_your_key_here`. If only **OAuth** or
   **No authentication** are available, Engram can't connect this way yet — use
   option 2 or an MCP‑native client below.

> Requires a paid ChatGPT tier (Plus/Pro/Business/Enterprise). Availability of
> Developer mode varies by tier and region.

### 2. Custom GPT with Actions (workaround)

If you have ChatGPT Plus/Team/Enterprise, you can create a Custom GPT that calls
Engram's **REST API** via Actions:

1. Go to **Explore GPTs** → **Create**.
2. In **Configure**, add **Actions**.
3. Define an OpenAPI schema for Engram's REST endpoints.
4. Add your API key in the Action's authentication settings (Bearer token).
5. In the GPT's instructions, add auto‑memory behavior:

```
You have access to Engram memory via your actions.

At the start of each conversation, search Engram for relevant prior context
using the search action with a summary of the user's first message.

When you learn something important or make a significant decision, store it
using the create_conversation and append_messages actions.

What to store:
- User preferences and personal details
- Decisions and reasoning
- Important facts the user wants remembered

What NOT to store:
- Casual greetings
- Temporary or trivial information
```

> **Note:** This requires Engram's REST API, which is on the
> [roadmap](../roadmap.md). The MCP protocol is not accessible via Custom GPT
> Actions — Actions speak REST/OpenAPI, not MCP.

### 3. Use an MCP‑native client (works today)

For full auto‑memory right now, use an MCP‑compatible client. These connect to
Engram with a single config block and a Bearer header:

| Client | Best for |
|--------|----------|
| [Claude Desktop](./claude-desktop.md) | General conversations, research, personal use |
| [Claude Code](./claude-code.md) | CLI-based coding and engineering |
| [Cursor](./cursor.md) | IDE-based coding |
| [Windsurf](./windsurf.md) | IDE-based coding with Cascade flows |
| [Codex CLI](./codex.md) | CLI-based coding with OpenAI models |

## Shared Memory

Memories stored by any client are available to the others — investigate
something in Claude Code, and the context is there next time you use Cursor or
Windsurf. Once Engram supports ChatGPT's auth model, ChatGPT will have access to
the full history too.

We'll update this guide as ChatGPT's connector auth options (or Engram's OAuth /
REST support) change.
