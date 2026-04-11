# @getengram/sdk

TypeScript SDK for [Engram](https://getengram.app) — persistent memory for AI agents.

Give your agents long-term memory without blowing up token costs. Engram stores every message verbatim — no compression, no summarization — and provides semantic search so agents recall the right context at the right time.

## Install

```bash
npm install @getengram/sdk
```

## Quick Start

```typescript
import { Engram } from '@getengram/sdk'

const engram = new Engram({ apiKey: process.env.ENGRAM_API_KEY! })

// Create a conversation
const { conversationId } = await engram.createConversation({
  title: 'Deploy Session',
  tags: ['prod', 'deploy'],
})

// Store messages (verbatim, automatically chunked + embedded)
await engram.store({
  conversationId,
  messages: [
    { role: 'user', content: 'Deploy the API to prod' },
    { role: 'assistant', content: 'Running deploy...' },
    { role: 'tool', content: 'Success: v2.1.0', toolName: 'deploy' },
  ],
})

// Semantic search across all memory
const { results } = await engram.search({ query: 'when did we deploy v2?' })

for (const result of results) {
  console.log(`[${(result.score * 100).toFixed(0)}%] ${result.chunkText}`)
}
```

## API Reference

### `new Engram(config)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | *required* | API key (`engram_sk_live_...`) |
| `baseUrl` | `string` | `https://mcp.getengram.app` | Custom endpoint |
| `timeout` | `number` | `30000` | Request timeout (ms) |

### `engram.createConversation(params?)`

Create a new conversation.

```typescript
const { conversationId } = await engram.createConversation({
  title: 'My Chat',           // optional
  agentId: 'my-agent',        // optional — filter conversations by agent
  tags: ['prod', 'deploy'],   // optional — filter conversations by tags
  metadata: { env: 'prod' },  // optional — arbitrary metadata
})
```

### `engram.store(params)`

Store messages in a conversation. Messages are stored verbatim and automatically chunked + embedded for semantic search.

```typescript
const { appended, messageIds } = await engram.store({
  conversationId: 'conv_abc',
  messages: [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there!' },
    { role: 'tool', content: '{"status": "ok"}', toolName: 'api_check' },
  ],
})
```

**Message fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `role` | `"user" \| "assistant" \| "system" \| "tool"` | yes | Message role |
| `content` | `string` | yes | Full message content (stored verbatim) |
| `toolName` | `string` | no | Tool name for tool messages |
| `toolCallId` | `string` | no | Tool call ID reference |
| `metadata` | `object` | no | Arbitrary metadata |

### `engram.search(params)`

Semantic search across stored conversations.

```typescript
const { results, total } = await engram.search({
  query: 'deployment issues',
  limit: 10,                    // optional (1-50, default: 10)
  conversationId: 'conv_abc',   // optional — limit to one conversation
  tags: ['prod'],               // optional — filter by conversation tags
})

// Each result:
// result.score          — 0-1 relevance score
// result.conversationId — which conversation matched
// result.chunkText      — matched text chunk
// result.messages       — full verbatim messages in the chunk
```

### `engram.getConversation(params)`

Get a conversation with its messages. Supports pagination.

```typescript
// String shorthand
const { conversation, messages } = await engram.getConversation('conv_abc')

// With pagination
const { conversation, messages } = await engram.getConversation({
  conversationId: 'conv_abc',
  messageLimit: 50,
  messageOffset: 100,
})
```

### `engram.listConversations(params?)`

List conversations with filtering and sorting.

```typescript
const { conversations, total } = await engram.listConversations({
  limit: 20,              // optional (1-100, default: 20)
  offset: 0,              // optional
  agentId: 'my-agent',    // optional
  tags: ['prod'],         // optional
  sort: 'updated_at',     // optional: created_at, updated_at, message_count
  order: 'desc',          // optional: asc, desc
})
```

### `engram.deleteConversation(conversationId)`

Delete a conversation and all its messages, chunks, and vector embeddings.

```typescript
const { deleted } = await engram.deleteConversation('conv_abc')
```

## Error Handling

```typescript
import { Engram, EngramError, AuthenticationError, TimeoutError } from '@getengram/sdk'

try {
  await engram.search({ query: 'test' })
} catch (err) {
  if (err instanceof AuthenticationError) {
    // Invalid or expired API key
  } else if (err instanceof TimeoutError) {
    // Request timed out
  } else if (err instanceof EngramError) {
    // General API error
    console.error(err.message, err.code)
  }
}
```

## Use with AI Frameworks

### Vercel AI SDK

```typescript
import { Engram } from '@getengram/sdk'
import { generateText } from 'ai'

const engram = new Engram({ apiKey: process.env.ENGRAM_API_KEY! })

// Retrieve relevant context before generating
const { results } = await engram.search({ query: userMessage })
const context = results.map(r => r.chunkText).join('\n\n')

const { text } = await generateText({
  model: yourModel,
  system: `Use this context:\n${context}`,
  prompt: userMessage,
})

// Store the exchange
await engram.store({
  conversationId,
  messages: [
    { role: 'user', content: userMessage },
    { role: 'assistant', content: text },
  ],
})
```

### MCP (Model Context Protocol)

Engram also runs as a native MCP server. Add to your Claude Code or Cursor config:

```json
{
  "mcpServers": {
    "engram": {
      "type": "http",
      "url": "https://mcp.getengram.app/mcp",
      "headers": {
        "Authorization": "Bearer engram_sk_live_YOUR_KEY"
      }
    }
  }
}
```

## Requirements

- Node.js 18+ (uses native `fetch`)
- TypeScript 5+ (for types)

## License

MIT — [getengram.app](https://getengram.app)
