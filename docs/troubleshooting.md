# Troubleshooting

## Connection Issues

### "401 Unauthorized"

Your API key is missing, malformed, or not found.

- Check that the `Authorization` header is set: `Bearer engram_sk_live_...`
- Verify the key prefix is `engram_sk_live_` (not `engram_sk_test_` or something else)
- Ensure the key hasn't been revoked
- Keys are case-sensitive — copy the full key exactly as shown at creation

### "403 Forbidden"

Your API key exists but is expired or revoked.

- Check if the key has an expiration date that has passed
- Check if the key was revoked by an admin

### "Conversation not found"

The conversation ID doesn't exist or belongs to a different organization.

- Verify the `conv_` prefixed ID is correct
- Each API key is scoped to one organization — you can't access conversations from a different org

### Connection timeout / refused

If using a self-hosted instance:

- Verify the Worker is deployed: `wrangler deployments list`
- Check the Worker URL is correct (e.g., `https://engram-mcp-server.your-subdomain.workers.dev/mcp`)
- For local dev, ensure `wrangler dev` is running on the expected port (default: 8787)
- Check the `/health` endpoint returns 200

## Search Issues

### Search returns no results

- Messages need to be appended via `append_messages` to be indexed. Messages aren't searchable until they've been chunked and embedded.
- If you just appended messages, there may be a brief delay for Vectorize indexing (typically <1 second).
- Check that you're searching within the correct organization (API key scope).
- If filtering by `conversation_id` or `tags`, verify those filters match existing data.

### Search results seem irrelevant

- Semantic search works on meaning, not keywords. "authentication error" will match "login failed" even though they share no words.
- Try rephrasing your query in natural language.
- Use more specific queries for better results.
- Reduce the `limit` to get only the highest-confidence matches.

### Search doesn't find recent messages

Messages are chunked in windows of 5. If you've appended fewer than 5 messages to a conversation, they'll still be chunked and searchable, but short conversations may produce lower-confidence matches.

## Data Issues

### Messages appear out of order

Messages are ordered by `sequence` number, not by timestamp. If messages appear out of order, check the sequence values in the response.

Sequence numbers are assigned automatically based on the order messages appear in the `messages` array of `append_messages`. They're always sequential within a conversation.

### Tags or metadata not showing up

Tags and metadata are stored as JSON strings in D1. When retrieved via `get_conversation` or `list_conversations`, they're parsed back into arrays/objects. If tags appear as a string like `"[\"tag1\"]"`, there may be a double-encoding issue.

### Can't delete a conversation

`delete_conversation` cascades: it removes the conversation, all its messages, all chunks, and all vectors from the search index. If it returns "Conversation not found", verify the ID and that it belongs to your organization.

## Self-Hosting Issues

### Migrations fail

```bash
# Check migration status
wrangler d1 migrations list engram-db --local

# Re-apply migrations
wrangler d1 migrations apply engram-db --local
```

### Vectorize index not found

Create it manually:

```bash
wrangler vectorize create engram-vectors --dimensions=768 --metric=cosine
```

Ensure the index name in `wrangler.toml` matches:

```toml
[[vectorize]]
binding = "VECTORIZE"
index_name = "engram-vectors"
```

### Workers AI errors

The `@cf/baai/bge-base-en-v1.5` model is free and available on all Cloudflare accounts. If you get errors:

- Ensure `[ai]` binding is configured in `wrangler.toml`
- Check Cloudflare dashboard for any account-level restrictions
- For local development, Workers AI requires an internet connection (it calls Cloudflare's edge)

### Build errors

```bash
# Clean install
rm -rf node_modules
pnpm install

# Build all packages
pnpm build

# Check types
pnpm typecheck
```

The build order matters: `@engram/shared` must build before `@engram/db`, which must build before `@engram/mcp-server`. Turborepo handles this automatically with `pnpm build`.
