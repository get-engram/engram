# Integration Guides

Step-by-step guides for using Engram with your AI tools. Each guide covers connection setup, automatic memory configuration, and real-world examples.

## IDE & CLI Agents

| Guide | Tool | Auto-Memory File |
|-------|------|-----------------|
| **[Claude Code](./claude-code.md)** | Anthropic's CLI agent | `CLAUDE.md` |
| **[Codex CLI](./codex.md)** | OpenAI's CLI agent | `AGENTS.md` |
| **[Cursor](./cursor.md)** | AI-native IDE | `.cursorrules` |
| **[Windsurf](./windsurf.md)** | AI-native IDE | `.windsurfrules` |

## Desktop & Chat

| Guide | Tool | Auto-Memory Setup |
|-------|------|------------------|
| **[Claude Desktop](./claude-desktop.md)** | Anthropic's desktop app | Project instructions |
| **[ChatGPT](./chatgpt.md)** | OpenAI's chat interface | Not yet supported (workarounds listed) |

## Build Your Own

| Guide | Description |
|-------|-------------|
| **[Custom Agents](./custom-agents.md)** | TypeScript SDK, Python SDK, LangChain, Vercel AI SDK, Claude Agent SDK |

## Shared Memory

All guides use the same Engram API key format. If you use the same key across multiple tools, they share memory automatically:

```
Claude Code stores a decision → Cursor finds it next session
Codex investigates a bug → Claude Desktop recalls the resolution
Windsurf sets up a project → Claude Code knows the architecture
```

See the [Getting Started guide](../getting-started.md) for initial setup and API key creation.
