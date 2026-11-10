# Integrations

Engram works with any MCP-compatible client. Here's how to connect the most common ones.

## Claude Desktop

Add Engram as a custom connector: in Claude, open **Customize → Connectors**, click **+**, choose **Add custom connector**, and enter `https://mcp.getengram.app/mcp`. Claude opens Engram's sign-in page; approve the connection. The connector works in Claude on the web, desktop and mobile, and gives Claude Engram's 8 core memory tools.

To connect with an API key instead, use Claude Desktop's config file. It only runs local (stdio) servers, so Engram goes through [mcp-remote](https://github.com/geelen/mcp-remote) (needs Node.js 18 or later):

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

Restart Claude Desktop. With an API key, Claude gets the 8 core memory tools plus the vault and subscription tools. The [Claude Desktop guide](./guides/claude-desktop.md) covers the details, including Windows.

## Claude Code (CLI)

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "engram": {
      "type": "http",
      "url": "https://mcp.getengram.app/mcp",
      "headers": {
        "Authorization": "Bearer engram_sk_live_your_key_here"
      }
    }
  }
}
```

Or add it to all your projects:

```bash
claude mcp add --transport http --scope user engram https://mcp.getengram.app/mcp \
  --header "Authorization: Bearer engram_sk_live_your_key_here"
```

## Cursor

In Cursor Settings > MCP, add a new server:

- **Name:** engram
- **Type:** HTTP
- **URL:** `https://mcp.getengram.app/mcp`
- **Headers:** `Authorization: Bearer engram_sk_live_your_key_here`

## Windsurf

Add to your Windsurf MCP configuration:

```json
{
  "mcpServers": {
    "engram": {
      "serverUrl": "https://mcp.getengram.app/mcp",
      "headers": {
        "Authorization": "Bearer engram_sk_live_your_key_here"
      }
    }
  }
}
```

## Custom MCP Client (TypeScript)

Use the official `@modelcontextprotocol/sdk`:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(
  new URL("https://mcp.getengram.app/mcp"),
  {
    requestInit: {
      headers: {
        Authorization: "Bearer engram_sk_live_your_key_here",
      },
    },
  }
);

const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(transport);

// Create a conversation
const result = await client.callTool({
  name: "create_conversation",
  arguments: {
    title: "My first conversation",
    tags: ["test"],
  },
});

console.log(result);
// { content: [{ type: "text", text: '{"conversation_id":"conv_..."}' }] }
```

## Custom MCP Client (Python)

```python
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

async def main():
    headers = {
        "Authorization": "Bearer engram_sk_live_your_key_here"
    }

    async with streamablehttp_client(
        "https://mcp.getengram.app/mcp",
        headers=headers
    ) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()

            result = await session.call_tool(
                "search",
                arguments={"query": "billing issue", "limit": 5}
            )
            print(result)
```

## MCP Inspector

For testing and debugging, use the MCP Inspector:

```bash
npx @anthropic-ai/mcp-inspector
```

Enter your server URL (`https://mcp.getengram.app/mcp`) and API key. You can interactively call tools, inspect schemas, and see responses.

## Using with AI Frameworks

### LangChain / LangGraph

Engram works as an MCP tool provider. Use LangChain's MCP integration to connect:

```typescript
import { McpToolkit } from "@langchain/mcp";

const toolkit = new McpToolkit({
  servers: {
    engram: {
      url: "https://mcp.getengram.app/mcp",
      headers: {
        Authorization: "Bearer engram_sk_live_your_key_here",
      },
    },
  },
});

const tools = await toolkit.getTools();
// tools now contains create_conversation, append_messages, search, etc.
```

### Vercel AI SDK

Use the MCP client adapter:

```typescript
import { experimental_createMCPClient } from "ai";

const engram = await experimental_createMCPClient({
  transport: {
    type: "sse",
    url: "https://mcp.getengram.app/mcp",
    headers: {
      Authorization: "Bearer engram_sk_live_your_key_here",
    },
  },
});

const tools = await engram.tools();
```

## Self-Hosted URL

If you're [self-hosting](./self-hosting.md), replace `https://mcp.getengram.app/mcp` with your Worker URL:

```
https://engram-mcp-server.<your-subdomain>.workers.dev/mcp
```

Or for local development:

```
http://localhost:8787/mcp
```
