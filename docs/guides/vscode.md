# VS Code Integration Guide

Give GitHub Copilot in VS Code persistent memory across sessions using Engram. VS Code connects to Engram as an **MCP server**, and because that memory is shared, anything Copilot stores is also available in Cursor, Claude, ChatGPT, and every other connected tool.

> **Requires:** GitHub Copilot in VS Code with MCP support and **Agent mode** in Copilot Chat.

## Setup

### 1. Get an API Key

Sign up at [getengram.app](https://getengram.app).

### 2. Add the MCP Server

**Option A: Command Palette**

1. Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`).
2. Run **MCP: Add Server**.
3. Choose **HTTP** (a remote server), and enter the URL `https://mcp.getengram.app/mcp`.
4. Pick **Workspace** (saves to `.vscode/mcp.json`) or **Global** (user config).

**Option B: Config file**

Create `.vscode/mcp.json` in your project. VS Code uses a top-level `servers` key (not `mcpServers`), and `inputs` to prompt for secrets so your key isn't hardcoded:

```json
{
  "inputs": [
    {
      "id": "engram-key",
      "type": "promptString",
      "description": "Engram API key",
      "password": true
    }
  ],
  "servers": {
    "engram": {
      "type": "http",
      "url": "https://mcp.getengram.app/mcp",
      "headers": {
        "Authorization": "Bearer ${input:engram-key}"
      }
    }
  }
}
```

VS Code prompts for the key the first time the server starts and stores it securely. To open the user-level config instead, run **MCP: Open User Configuration**.

> Avoid hardcoding the key directly in `headers`. Use the `inputs` prompt above (or an environment file) so the value stays out of source control.

### 3. Verify

Open Copilot Chat, switch to **Agent** mode, and confirm Engram appears in the Tools picker (enable it if needed). Then ask it to search Engram — if it can call the `search` tool, you're connected.

---

## Automatic Memory

VS Code Copilot loads workspace instructions from `.github/copilot-instructions.md` into every Agent session — the equivalent of Cursor's `.cursorrules` or Claude Code's `CLAUDE.md`.

Create `.github/copilot-instructions.md` in your project root:

```markdown
## Engram Memory

You have access to Engram memory tools via MCP. Use them automatically.

### On session start

Search Engram for context relevant to the current task:

    search
      query: "<summary of what the user is asking about>"
      limit: 5

Include any relevant results in your working context.

### During the session

When something worth remembering is established, store it:

    create_conversation
      title: "<concise description>"
      agent_id: "vscode"
      tags: ["<project-name>", "<topic>"]

    append_messages
      conversation_id: "<id>"
      messages:
        - role: "user"
          content: "<what the user asked>"
        - role: "assistant"
          content: "<what you did and why>"

### What to store

- Decisions and their reasoning
- Bug investigations and resolutions
- User preferences and coding style
- Architecture discussions

### What NOT to store

- Routine code generation
- File reads and searches
- Information already in git
```

---

## Agent Mode is Required

MCP tools are only available in Copilot Chat's **Agent mode**, where Copilot can autonomously call tools. Ask, Edit, and inline modes won't trigger Engram. Select **Agent** at the top of the Chat view, and make sure Engram's tools are enabled in the Tools picker.

## How capture works

Like Cursor and Claude Desktop, VS Code capture is **on request via MCP** — Copilot stores memories when the task or your instructions call for it. It's reliable for the context you want kept. (Automatic, verbatim capture of every message is only available where a local agent can read the transcript, such as Claude Code.)

## Tips

- **Commit `.github/copilot-instructions.md`** so everyone on the team gets auto-memory behavior.
- **Use `.vscode/mcp.json`** for per-project setup and share it with your team (the `inputs` prompt keeps the key out of the repo).
- **Combine with other tools.** Same API key = shared memory. Debug in VS Code, recall the context in Claude Code or Cursor.
