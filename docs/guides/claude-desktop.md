# Claude Desktop Integration Guide

Give Claude Desktop persistent memory across conversations using Engram.

## Easiest: add Engram as a connector

No config file and no API key to copy. The connector works in Claude Desktop, on claude.ai and in the Claude mobile apps.

1. Sign up free at [getengram.app](https://getengram.app) (if you haven't).
2. In Claude, open **Customize → Connectors**, click **+**, and choose **Add custom connector**.
3. Name it **Engram**, enter the URL `https://mcp.getengram.app/mcp`, and add it. Leave the sign-in settings at their defaults.
4. Claude opens Engram's sign-in page. Sign in and approve the connection.

Claude now has Engram's 8 core memory tools. To check the connection, ask Claude **"Which Engram account are you using?"** It answers with Engram's `whoami` tool.

Custom connectors work on every Claude plan; the Free plan allows one. On Team and Enterprise plans, an owner may need to add Engram first under **Organization settings → Connectors**.

## Alternative: config-file setup

Use this to connect with an API key or to a self-hosted instance. Claude Desktop's config file only runs local (stdio) servers, so it reaches Engram through [mcp-remote](https://github.com/geelen/mcp-remote), a small bridge that needs [Node.js](https://nodejs.org) 18 or later.

### 1. Get an API Key

Sign up at [getengram.app](https://getengram.app) or [self-host](../self-hosting.md) your own instance.

### 2. Add the MCP Server

In Claude Desktop, open **Settings → Developer → Edit Config**, or open the file directly:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "engram": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://mcp.getengram.app/mcp",
        "--header",
        "Authorization:${ENGRAM_AUTH}"
      ],
      "env": {
        "ENGRAM_AUTH": "Bearer engram_sk_live_your_key_here"
      }
    }
  }
}
```

For a self-hosted instance, use your server's `/mcp` URL in place of `https://mcp.getengram.app/mcp`.

Keep `Authorization:${ENGRAM_AUTH}` exactly as written, with no space after the colon. mcp-remote recommends this form because Claude Desktop on Windows breaks arguments that contain spaces. To sign in through your browser instead of using a key, use `"args": ["-y", "mcp-remote", "https://mcp.getengram.app/mcp"]` and leave out the `env` block.

Don't put a `url` or `headers` entry in this file. Claude Desktop doesn't connect to remote servers listed there; each server needs a `command`.

### 3. Restart Claude Desktop

Quit and reopen Claude Desktop. With an API key, Claude gets Engram's 8 core memory tools plus the vault and subscription tools. Signed in through the browser instead, it gets the 8 core tools.

---

## Automatic Memory

Claude Desktop supports **Projects** with custom instructions. This is how you set up auto-memory.

### Create a Project with Memory Instructions

1. Open Claude Desktop
2. Click **Projects** in the sidebar
3. Create a new project (or open an existing one)
4. Click the project settings and add **Custom Instructions**:

```
You have access to Engram memory tools. Use them automatically — the user should not need to ask you to remember or recall.

## On conversation start

Search Engram for context relevant to the user's first message:

  search
    query: "<summary of what the user is asking about>"
    limit: 5

If results are relevant, use them to inform your response. Mention if you found relevant prior context ("I recall from our previous conversation that...").

## During the conversation

When you learn something important, store it:

  create_conversation
    title: "<concise description>"
    agent_id: "claude-desktop"
    tags: ["<topic>"]

  append_messages
    conversation_id: "<id>"
    messages:
      - role: "user"
        content: "<what the user said>"
      - role: "assistant"
        content: "<what you said and why>"

## What to store

- User preferences and personal details they share
- Decisions and reasoning
- Important facts the user wants remembered
- Project context and goals
- Anything the user would expect you to know next time

## What NOT to store

- Casual greetings or small talk
- Information you can look up
- Temporary or time-sensitive details
```

### How It Works

1. Every conversation in that project uses the custom instructions
2. Claude searches Engram at the start of each conversation
3. Important context is stored during the conversation
4. Next conversation, Claude recalls relevant prior context

---

## Example: Memory in Action

**Conversation 1:**

```
You: I'm starting a new project using Next.js and Supabase.
     We need to support multi-tenancy with row-level security.

Claude: [stores in Engram:
  title: "New project: Next.js + Supabase with multi-tenancy"
  tags: ["project-setup", "architecture"]
  messages: project stack choice and multi-tenancy requirement]

Claude: Great choice. For multi-tenancy with Supabase RLS, I'd recommend...
```

**Conversation 2 (days later):**

```
You: How should we handle the auth flow?

Claude: [searches Engram → finds conversation about Next.js + Supabase project]
Claude: Since we're using Next.js with Supabase and need multi-tenancy
        with RLS, I'd recommend using Supabase Auth with custom claims
        for the tenant ID. This way the RLS policies can reference
        auth.jwt()->'tenant_id' directly...
```

Claude remembers the project context without being reminded.

---

## Multiple Projects

You can create separate projects for different areas of your life:

| Project | Use case |
|---------|----------|
| Work - Engineering | Technical decisions, codebase context |
| Work - Management | Meeting notes, team context |
| Personal | Preferences, travel plans, recommendations |
| Research | Topics you're exploring, papers discussed |

All projects share the same Engram memory (same Engram account), so context from one project can surface in another if relevant. The `agent_id` and `tags` help distinguish where memories came from.

---

## Tips

- **Be specific in project instructions.** The more context you give Claude about what to remember, the better its memory will be.
- **Use different tags per project.** This helps filter memories when searching.
- **Mention prior context.** If Claude recalls something from Engram, it will mention it. If it misses something, just say "remember when we discussed X?" — it will search again.
- **Works with Claude Code.** If Claude Code and Claude Desktop connect to the same Engram account, they share memory. Debug a bug in Claude Code, discuss the architecture in Claude Desktop.
