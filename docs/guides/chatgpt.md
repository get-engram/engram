# ChatGPT Integration Guide

ChatGPT does **not** natively support MCP servers. This page documents the current state and available workarounds.

## Current Status

As of March 2026, ChatGPT (web, mobile, and desktop) does not support connecting to MCP servers. There is no config file or settings panel for adding MCP endpoints like Engram.

## Workarounds

### Option 1: Custom GPT with Actions

If you have a ChatGPT Plus/Team/Enterprise subscription, you can create a Custom GPT that calls Engram's endpoints via Actions:

1. Go to **Explore GPTs** > **Create**
2. In **Configure**, add **Actions**
3. Define an OpenAPI schema for Engram's REST API endpoints (when available)
4. Add your API key in the Action's authentication settings
5. In the GPT's instructions, add auto-memory behavior:

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

> **Note:** This requires Engram's REST API, which is on the [roadmap](../roadmap.md). The MCP protocol is not accessible via Custom GPT Actions.

### Option 2: Use an MCP-Native Client

For full auto-memory with Engram, use an MCP-compatible client:

| Client | Best for |
|--------|----------|
| [Claude Desktop](./claude-desktop.md) | General conversations, research, personal use |
| [Claude Code](./claude-code.md) | CLI-based coding and engineering |
| [Cursor](./cursor.md) | IDE-based coding |
| [Windsurf](./windsurf.md) | IDE-based coding with Cascade flows |
| [Codex CLI](./codex.md) | CLI-based coding with OpenAI models |

All of these support MCP natively and can connect to Engram with a single config block.

## When ChatGPT Adds MCP Support

When ChatGPT adds MCP support (no announced timeline), connecting Engram will be straightforward — just add the server URL and API key in ChatGPT's settings. The auto-memory instructions would go in a Custom GPT's system prompt or in the ChatGPT project instructions.

We'll update this guide when MCP support is available.

## Shared Memory

Even though ChatGPT can't directly access Engram, you can still benefit from memories stored by other tools. Investigate something in Claude Code, and the context is available the next time you use Cursor or Windsurf. When ChatGPT gains MCP support, it will have access to the full history too.
