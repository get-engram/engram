# Custom Agent Integration Guide

Build agents with persistent memory using Engram and the MCP SDK.

## TypeScript MCP Client

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

// Search for prior context
const searchResult = await client.callTool({
  name: "search",
  arguments: { query: "user preferences", limit: 5 },
});

// Create a conversation
const createResult = await client.callTool({
  name: "create_conversation",
  arguments: {
    title: "Agent session — March 26",
    agent_id: "my-agent",
    tags: ["session"],
  },
});

const { conversation_id } = JSON.parse(createResult.content[0].text);

// Store messages
await client.callTool({
  name: "append_messages",
  arguments: {
    conversation_id,
    messages: [
      { role: "user", content: "What's the status of the deployment?" },
      { role: "assistant", content: "The deployment completed at 3pm. All health checks passing." },
    ],
  },
});
```

## Python MCP Client

```python
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client
import json

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

            # Search for prior context
            result = await session.call_tool(
                "search",
                arguments={"query": "deployment status", "limit": 5}
            )
            print(result)

            # Create and store a conversation
            create = await session.call_tool(
                "create_conversation",
                arguments={
                    "title": "Deployment check",
                    "agent_id": "my-python-agent",
                    "tags": ["ops"]
                }
            )
            conv_id = json.loads(create.content[0].text)["conversation_id"]

            await session.call_tool(
                "append_messages",
                arguments={
                    "conversation_id": conv_id,
                    "messages": [
                        {"role": "user", "content": "Check deployment status"},
                        {"role": "assistant", "content": "All systems green."}
                    ]
                }
            )
```

---

## Framework Integrations

### LangChain / LangGraph

Use LangChain's MCP integration to add Engram tools to your agent:

```typescript
import { McpToolkit } from "@langchain/mcp";
import { ChatAnthropic } from "@langchain/anthropic";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

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
const model = new ChatAnthropic({ model: "claude-sonnet-4-6" });

const agent = createReactAgent({
  llm: model,
  tools,
});

const result = await agent.invoke({
  messages: [{ role: "user", content: "What do you remember about the auth migration?" }],
});
```

### Vercel AI SDK

```typescript
import { experimental_createMCPClient } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";

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

const { text } = await generateText({
  model: anthropic("claude-sonnet-4-6"),
  tools,
  prompt: "Search Engram for recent architecture decisions",
});
```

### Claude Agent SDK

```python
from claude_agent_sdk import Agent

agent = Agent(
    model="claude-sonnet-4-6",
    mcp_servers=[{
        "url": "https://mcp.getengram.app/mcp",
        "headers": {
            "Authorization": "Bearer engram_sk_live_your_key_here"
        }
    }]
)

result = agent.run("What do you remember about the database migration?")
```

---

## System Prompt Pattern for Auto-Memory

When building a custom agent, add this to your system prompt to enable auto-memory:

```
You have persistent memory via Engram. Use it automatically.

BEFORE responding to the user:
1. Search Engram for relevant prior context:
   search(query: "<summary of user's message>", limit: 5)
2. Include any relevant results in your reasoning

AFTER significant interactions, store context:
1. create_conversation(title: "<topic>", agent_id: "<your-agent-id>", tags: [...])
2. append_messages(conversation_id: "<id>", messages: [<key messages from this session>])

Store: decisions, preferences, investigation results, important context.
Skip: greetings, routine lookups, information already in external systems.
```

---

## Building an Agent with Memory: Full Example

Here's a complete example of a support agent that remembers customer interactions:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Anthropic from "@anthropic-ai/sdk";

// Connect to Engram
const transport = new StreamableHTTPClientTransport(
  new URL("https://mcp.getengram.app/mcp"),
  {
    requestInit: {
      headers: { Authorization: "Bearer engram_sk_live_your_key_here" },
    },
  }
);
const engram = new Client({ name: "support-agent", version: "1.0.0" });
await engram.connect(transport);

// Search for customer history
async function getCustomerContext(customerId: string, issue: string) {
  const result = await engram.callTool({
    name: "search",
    arguments: {
      query: `customer ${customerId} ${issue}`,
      tags: ["support"],
      limit: 5,
    },
  });
  return JSON.parse(result.content[0].text);
}

// Store the interaction
async function storeInteraction(customerId: string, messages: any[]) {
  const create = await engram.callTool({
    name: "create_conversation",
    arguments: {
      title: `Support: ${customerId}`,
      agent_id: "support-agent",
      tags: ["support", customerId],
    },
  });
  const { conversation_id } = JSON.parse(create.content[0].text);

  await engram.callTool({
    name: "append_messages",
    arguments: { conversation_id, messages },
  });
}

// Handle a support request
async function handleSupport(customerId: string, message: string) {
  // 1. Get prior context
  const history = await getCustomerContext(customerId, message);

  // 2. Build prompt with memory
  const anthropic = new Anthropic();
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: `You are a support agent. Here is the customer's prior history:\n${JSON.stringify(history.results)}`,
    messages: [{ role: "user", content: message }],
  });

  const reply = response.content[0].text;

  // 3. Store this interaction
  await storeInteraction(customerId, [
    { role: "user", content: message },
    { role: "assistant", content: reply },
  ]);

  return reply;
}
```

---

## Tips

- **Use unique `agent_id` values** for each agent you build. This makes it easy to filter conversations by source.
- **Tag strategically.** Tags like `["support", "customer_123"]` make it easy to search for a specific customer's full history.
- **Batch messages.** Send all messages from a session in a single `append_messages` call rather than one at a time — this produces better chunks for search.
- **Search before responding.** The most impactful memory pattern is searching at the start of every interaction. Even if nothing is found, the cost is minimal (~100ms).
