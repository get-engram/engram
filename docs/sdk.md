# SDK Reference — @getengram/sdk

TypeScript SDK for programmatic access to Engram's persistent memory API.

## Install

```bash
npm install @getengram/sdk
```

## Initialize

```typescript
import { Engram } from '@getengram/sdk'

const engram = new Engram({
  apiKey: process.env.ENGRAM_API_KEY!,
  // baseUrl: 'http://localhost:8787',  // optional — for local dev
  // timeout: 30000,                     // optional — request timeout (ms)
})
```

## Methods

### createConversation

Create a new conversation container.

```typescript
const { conversationId } = await engram.createConversation({
  title: 'Sprint Planning',
  agentId: 'planning-bot',
  tags: ['sprint-42', 'planning'],
  metadata: { team: 'backend' },
})
// → { conversationId: 'conv_KRU80QIFd1BJNxqdR4yLR' }
```

All parameters are optional. A conversation with no title is allowed.

### store

Append messages to a conversation. Messages are stored verbatim and automatically chunked + embedded for semantic search.

```typescript
const { appended, messageIds } = await engram.store({
  conversationId: 'conv_abc',
  messages: [
    { role: 'user', content: 'What broke in the deploy?' },
    { role: 'assistant', content: 'The migration script failed on the users table...' },
    { role: 'tool', content: '{"error": "column already exists"}', toolName: 'pg_migrate' },
  ],
})
// → { appended: 3, messageIds: ['msg_...', 'msg_...', 'msg_...'] }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `role` | `"user" \| "assistant" \| "system" \| "tool"` | yes | Message role |
| `content` | `string` | yes | Verbatim message content |
| `toolName` | `string` | no | Tool name (for tool messages) |
| `toolCallId` | `string` | no | Tool call ID reference |
| `metadata` | `Record<string, unknown>` | no | Arbitrary per-message metadata |

### search

Semantic search across all stored conversations. Returns matching chunks with relevance scores and the original verbatim messages.

```typescript
const { results, total } = await engram.search({
  query: 'migration failure',
  limit: 5,
  tags: ['backend'],
})

for (const result of results) {
  console.log(`${(result.score * 100).toFixed(0)}% match in ${result.conversationId}`)
  for (const msg of result.messages) {
    console.log(`  [${msg.role}] ${msg.content}`)
  }
}
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | `string` | *required* | Natural language search query |
| `limit` | `number` | `10` | Max results (1–50) |
| `conversationId` | `string` | — | Limit to one conversation |
| `tags` | `string[]` | — | Filter by conversation tags |

### getConversation

Retrieve a conversation and its messages with pagination support.

```typescript
// String shorthand
const { conversation, messages } = await engram.getConversation('conv_abc')

// With pagination
const page2 = await engram.getConversation({
  conversationId: 'conv_abc',
  messageLimit: 50,
  messageOffset: 50,
})
```

### listConversations

List conversations with filtering and sorting.

```typescript
const { conversations, total } = await engram.listConversations({
  agentId: 'planning-bot',
  tags: ['sprint-42'],
  sort: 'updated_at',
  order: 'desc',
  limit: 10,
})
```

### deleteConversation

Delete a conversation and all associated data (messages, chunks, embeddings).

```typescript
await engram.deleteConversation('conv_abc')
```

## Error Handling

```typescript
import {
  Engram,
  EngramError,          // Base error
  AuthenticationError,   // 401 — bad/missing API key
  NotFoundError,         // 404 — conversation not found
  TimeoutError,          // Request timed out
} from '@getengram/sdk'

try {
  await engram.search({ query: 'test' })
} catch (err) {
  if (err instanceof AuthenticationError) {
    console.error('Bad API key')
  } else if (err instanceof TimeoutError) {
    console.error('Request timed out — try again')
  } else if (err instanceof EngramError) {
    console.error(err.message, err.code, err.status)
  }
}
```

## Types

All types are exported from the package:

```typescript
import type {
  EngramConfig,
  MessageRole,
  MessageInput,
  Message,
  Conversation,
  SearchResult,
  CreateConversationParams,
  CreateConversationResponse,
  StoreParams,
  StoreResponse,
  SearchParams,
  SearchResponse,
  GetConversationParams,
  GetConversationResponse,
  ListConversationsParams,
  ListConversationsResponse,
  DeleteConversationResponse,
} from '@getengram/sdk'
```

## Architecture

The SDK communicates with Engram's MCP server using JSON-RPC over HTTP. All requests are authenticated via Bearer token. The transport layer handles SSE response parsing and session management.

```
Your App → @getengram/sdk → HTTPS → mcp.getengram.app → Cloudflare Workers
                                                        ├── D1 (SQLite)
                                                        ├── Vectorize (embeddings)
                                                        └── Workers AI (bge-base-en-v1.5)
```

## Requirements

- Node.js 18+ (native `fetch`)
- TypeScript 5+ (for type definitions)
- Zero runtime dependencies
