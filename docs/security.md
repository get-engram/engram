# Security

## Overview

Engram is designed with multi-tenant security as a first principle. Every layer — authentication, database queries, vector search — enforces tenant isolation.

## Authentication

### API Key Security

- **Hashed storage:** Raw API keys are never stored. Only the SHA-256 hash is persisted in the database.
- **One-time display:** The full key is shown exactly once at creation. It cannot be retrieved after that.
- **Prefix identification:** The first 20 characters of each key are stored as `key_prefix` so keys can be identified in dashboards without exposing the full secret.
- **Expiration:** Keys can have an `expires_at` timestamp. Expired keys are rejected during authentication.
- **Revocation:** Keys can be revoked by setting `revoked_at`. Revoked keys are rejected immediately.
- **Audit trail:** `last_used_at` is updated on every request (non-blocking via `waitUntil`).

### Key Validation Flow

```
Request arrives
  │
  ├─ Missing Authorization header? → 401
  ├─ Not "Bearer" scheme? → 401
  ├─ Doesn't start with "engram_sk_live_"? → 401
  │
  ▼
  SHA-256 hash the raw key
  │
  ├─ Hash not found in api_keys table? → 401
  ├─ Key has revoked_at set? → 403
  ├─ Key has expires_at in the past? → 403
  │
  ▼
  Extract organization_id → set auth context
  Update last_used_at (non-blocking)
  Continue to MCP handler
```

## Tenant Isolation

### Database Layer

Every D1 query includes an `organization_id` filter:

```sql
-- Listing conversations
SELECT * FROM conversations WHERE organization_id = ?

-- Fetching messages
SELECT * FROM messages WHERE conversation_id = ? AND organization_id = ?

-- Looking up chunks
SELECT * FROM conversation_chunks WHERE organization_id = ?
```

The `organization_id` is **denormalized** onto `messages` and `conversation_chunks` tables. This means tenant filtering happens directly on the queried table without JOINs — there's no path to accidentally bypass the filter through a join.

### Vector Search Layer

Vectorize queries include an `organization_id` metadata filter:

```typescript
env.VECTORIZE.query(vector, {
  topK: limit,
  filter: { organization_id: orgId },
});
```

Vectors from other organizations are excluded at the index level, not filtered after retrieval.

### Application Layer

The `organization_id` is:
1. Extracted from the API key during authentication
2. Set once in the auth context
3. Threaded through every service call as a required parameter
4. Never derived from user input — always from the authenticated key

There is no API to query across organizations. No admin mode, no superuser key.

## Data Protection

### In Transit

All traffic uses HTTPS. The `.app` TLD enforces HSTS — browsers will never connect over plain HTTP.

Cloudflare Workers terminate TLS at the edge, so traffic between the client and Engram is encrypted end-to-end.

### At Rest

Cloudflare D1 and Vectorize encrypt data at rest. Engram does not add application-level encryption on top of this.

### Content Storage

Message content is stored **verbatim** — exactly as sent by the client. Engram does not:
- Inspect or filter message content
- Send content to third-party services (embeddings are generated on Cloudflare's own Workers AI)
- Log message content outside of D1 storage
- Retain deleted data (cascade deletes remove all messages, chunks, and vectors)

## Embedding Privacy

Embeddings are generated using Cloudflare Workers AI (`@cf/baai/bge-base-en-v1.5`). This model runs on Cloudflare's infrastructure — message content is **not sent to OpenAI, Cohere, or any external embedding provider**.

The embedding flow stays entirely within Cloudflare's network:
```
Worker → Workers AI (same network) → Vectorize (same network)
```

## Cascade Deletion

When a conversation is deleted:

1. All vector embeddings are removed from Vectorize
2. All chunk records are deleted from D1
3. All message records are deleted from D1
4. The conversation record is deleted from D1

Foreign key constraints with `ON DELETE CASCADE` ensure database-level integrity. The Vectorize cleanup happens in application code before the D1 delete.

## Security Headers

The MCP server runs on Cloudflare Workers, which provides:
- Automatic DDoS protection
- TLS 1.3
- HTTP/2 and HTTP/3
- IP reputation filtering

## Reporting Vulnerabilities

If you discover a security vulnerability in Engram, please report it by opening a private issue at [github.com/27Club/engram](https://github.com/27Club/engram) or contacting the maintainers directly. Do not disclose vulnerabilities publicly before they are fixed.
