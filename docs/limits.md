# Limits and Quotas

## Engram Limits

### Per-Request Limits

| Resource | Limit | Notes |
|----------|-------|-------|
| Messages per `append_messages` call | 200 | Batch your messages in groups of 200 or fewer |
| Search results (`limit` param) | 50 max | Default: 10 |
| Messages per `get_conversation` (`message_limit`) | 500 max | Default: 100. Use pagination for longer conversations |
| Conversations per `list_conversations` (`limit`) | 100 max | Default: 20. Larger values are capped to 100, not rejected. `total` reports the full count — page with `offset` |
| Messages per export page (`GET /api/v1/export` `limit`) | 400 max | Default: 400. Follow `next_cursor` until it is `null` — see [Export](api-reference.md#export) |

### Data Limits

| Resource | Limit | Notes |
|----------|-------|-------|
| Message content size | 100,000 characters | Longer bodies are clipped and end with a visible `…[truncated: …]` marker. Screenshots and other base64-encoded files become a short note such as `[image not stored: PNG, 234 KB]` first, so they don't count toward it |
| Tags per conversation | No hard limit | Stored as JSON array. Keep reasonable for query performance |
| Metadata size | No hard limit | Stored as JSON object. Keep under a few KB |
| Title length | No hard limit | TEXT field |

### Chunking Parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| Window size | 5 messages | Number of messages per chunk |
| Stride | 3 messages | Step between consecutive chunk starts |
| Overlap | 2 messages | Messages shared between adjacent chunks |

These are fixed in the current release. Configurable chunking is on the roadmap.

## Cloudflare Platform Limits

Engram runs on Cloudflare's platform. These limits apply to self-hosted instances.

### Workers (Free Plan)

| Resource | Limit |
|----------|-------|
| Requests per day | 100,000 |
| CPU time per request | 10ms |
| Memory | 128MB |
| Script size | 1MB |

### Workers (Paid — $5/month)

| Resource | Limit |
|----------|-------|
| Requests per month | 10 million included, $0.50/million after |
| CPU time per request | 30 seconds |
| Memory | 128MB |
| Script size | 10MB |

### D1

| Resource | Free | Paid |
|----------|------|------|
| Storage | 5GB | 10GB+ |
| Rows read per day | 5 million | 50 billion |
| Rows written per day | 100,000 | 50 million |
| Databases | 10 | 50,000 |

### Vectorize

| Resource | Limit |
|----------|-------|
| Vectors per index | 5,000,000 |
| Dimensions | Up to 1536 (Engram uses 768) |
| Metadata per vector | 10KB |
| Namespaces per index | 1,000 |
| Indexes per account | 100 |

### Workers AI

| Resource | Limit |
|----------|-------|
| `bge-base-en-v1.5` | Free, unlimited |
| Max input tokens | 512 tokens per text |
| Batch size | 100 texts per call |

## Estimating Usage

### Storage

A typical message is ~200 bytes. A conversation with 100 messages uses ~20KB of message storage. With chunk overhead, roughly 25KB per 100-message conversation.

At D1's free tier (5GB):
- ~200,000 conversations with 100 messages each
- ~20 million individual messages

### Vectors

Each chunk produces one 768-dimensional vector. With a window of 5 and stride of 3, a 100-message conversation produces roughly 33 chunks.

At Vectorize's 5M vector limit:
- ~150,000 conversations with 100 messages each

### Requests

Each `append_messages` call is 1 Worker request. Each `search` is 1 request. At 100K requests/day (free tier), that's roughly:
- 100K message appends or searches per day
- ~4,000 per hour

## Rate Limiting

Requests are rate limited per organization with a token bucket. Limits scale by plan:

| Plan | Requests per minute |
|------|--------------------|
| Free | 30 |
| Pro | 120 |
| Student | 120 |
| Team | 300 |
| Enterprise | 600 |

Every response includes an `X-RateLimit-Limit` header. When you exceed the limit, the request returns `429 Too Many Requests` with a `retry_after` of 60 seconds. Billing endpoints are exempt. For self-hosted instances, Cloudflare's platform limits also apply.

## Monthly cost budgets

Two operations cost real compute — generating embeddings and running a search — so each plan carries a monthly budget for both. They are sized far above any legitimate use; they are abuse guards, not feature gates.

| Plan | Chunks indexed per month | Searches per month |
|------|--------------------------|--------------------|
| Free | 100,000 | 50,000 |
| Pro | 2,000,000 | 500,000 |
| Student | 2,000,000 | 500,000 |
| Team | 10,000,000 | 2,000,000 |
| Enterprise | Unlimited | Unlimited |

A chunk is one embedded window of a conversation: roughly five messages, or one slice of a long message. Every path that generates embeddings is charged — `append_messages`, the REST and dashboard save endpoints, and the search-index rebuild after a message edit or delete — in the number of chunks it actually embeds. The indexing counter is monotonic: deleting a message frees storage but never refunds indexing, so a save/delete loop cannot run the embedding model for free. The search counter is charged before the query runs, on every surface (MCP, REST, dashboard).

When a budget is exhausted the request returns `429` with `error` set to `indexing_quota_exceeded` or `search_quota_exceeded`, plus `limit`, `used` and `tier`. A message edit is refused before anything is written. A message delete always completes: the stale index entries are dropped, the window is just not re-embedded. Both counters reset with the monthly period and are reported by `GET /api/usage` as `indexing` and `searches`.
