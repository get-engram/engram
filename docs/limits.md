# Limits and Quotas

## Engram Limits

### Per-Request Limits

| Resource | Limit | Notes |
|----------|-------|-------|
| Messages per `append_messages` call | 200 | Batch your messages in groups of 200 or fewer |
| Search results (`limit` param) | 50 max | Default: 10 |
| Messages per `get_conversation` (`message_limit`) | 500 max | Default: 100. Use pagination for longer conversations |
| Conversations per `list_conversations` (`limit`) | 100 max | Default: 20. Use offset for pagination |

### Data Limits

| Resource | Limit | Notes |
|----------|-------|-------|
| Message content size | No hard limit | Practical limit ~100KB per message. D1 TEXT fields have no defined max |
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

Rate limiting is not yet implemented in the Engram MVP. It is planned for Phase 2. For self-hosted instances, Cloudflare's platform limits serve as a natural rate limit.
