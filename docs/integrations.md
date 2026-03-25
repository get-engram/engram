# Integrations

Engram works with any MCP-compatible client. Here's how to connect the most common ones.

## Claude Desktop

Add to your `claude_desktop_config.json`:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "engram": {
      "url": "https://mcp.getengram.app/mcp",
      "headers": {
        "Authorization": "Bearer engram_sk_live_your_key_here"
      }
    }
  }
}
```

Restart Claude Desktop. Engram's 6 tools will appear in Claude's tool list.

## Claude Code (CLI)

Add to your project's `.mcp.json` or global config:

```json
{
  "mcpServers": {
    "engram": {
      "type": "url",
      "url": "https://mcp.getengram.app/mcp",
      "headers": {
        "Authorization": "Bearer engram_sk_live_your_key_here"
      }
    }
  }
}
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
