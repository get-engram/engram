# FAQ

## General

### What is Engram?

Engram is a memory service for AI agents. It stores complete, uncompressed conversation transcripts and makes them searchable via semantic search. It's accessible through the Model Context Protocol (MCP).

### How is Engram different from Mem0, Zep, or Supermemory?

Those products extract and compress conversations into distilled "memories." Engram stores the full, verbatim transcript. When you search Engram, you get back the actual conversation — not a summary.

This matters because summaries lose context. A memory like "user prefers TypeScript" doesn't capture _why_ they prefer it, what they've tried before, or the nuances of their preference. The full conversation does.

### What is MCP?

The [Model Context Protocol](https://modelcontextprotocol.io) is an open standard for connecting AI models to external tools and data sources. Engram implements MCP, so it works with any MCP-compatible client — Claude Desktop, Claude Code, Cursor, Windsurf, and custom agents.

### Is Engram open source?

No. Engram is a proprietary product. See [getengram.app](https://getengram.app) for pricing and plans.

## Data and Privacy

### Where is my data stored?

On Cloudflare's network. Conversations and messages are stored in D1 (SQLite at the edge). Search embeddings are stored in Vectorize. Both are managed by Cloudflare with automatic replication.

If you self-host, data stays on your own Cloudflare account.

### Is my data encrypted?

Data is encrypted at rest and in transit by Cloudflare. API keys are hashed with SHA-256 before storage — the raw key is never stored.

For sensitive data in conversations, Engram's [Secrets Vault](./vault.md) adds client-side AES-256-GCM encryption — secrets are encrypted before they leave your machine, and the server never sees plaintext.

### Can one organization see another's data?

No. Every query is scoped by `organization_id`. The ID is determined by the API key used, and all database queries and vector searches filter by it. There is no API to query across organizations.

### Can I export my data?

You can retrieve all conversations via `list_conversations` and `get_conversation` with pagination. Full export tooling is planned for a future release.

### Can I delete all my data?

Delete conversations individually with `delete_conversation`. This removes the conversation, all messages, all chunks, and all vector embeddings. Bulk deletion is planned for a future release.

## Technical

### What embedding model does Engram use?

`@cf/baai/bge-base-en-v1.5` — a 768-dimensional embedding model that runs on Cloudflare Workers AI at no cost. It's optimized for semantic similarity tasks.

### How does semantic search work?

When messages are appended, they're grouped into overlapping chunks (windows of 5 messages). Each chunk is embedded into a 768-dimensional vector. When you search, your query is embedded with the same model and compared against all stored vectors using cosine similarity. The most similar chunks are returned with their original messages.

### What are the size limits?

| Resource | Limit |
|----------|-------|
| D1 storage | 5GB free, 10GB paid |
| Vectorize vectors | 5M |
| Messages per append | 200 |
| Search results | 50 max |
| Message content | No hard limit (practical limit ~100KB) |

### How fast is search?

Typically under 100ms for the full pipeline: embedding the query (~20ms), vector search (~10ms), fetching chunks and messages from D1 (~20ms). Actual latency depends on the user's distance from the nearest Cloudflare data center.

### Does Engram support streaming?

The MCP transport uses Streamable HTTP, which supports server-sent events. However, Engram's tool responses are complete JSON objects — there's no token-by-token streaming of results.

### Can I use Engram without MCP?

Not yet. The current MVP only exposes MCP tools. A REST API is planned for Phase 2.

### How do I protect secrets and credentials in my conversations?

Enable the [Secrets Vault](./vault.md). Generate a vault key with `engram vault keygen --save`, then set `ENGRAM_VAULT_KEY` or pass it in the SDK config. The SDK automatically detects API keys, passwords, connection strings, PII, and other sensitive patterns, encrypts them client-side, and replaces them with `[VAULT:vlt_...]` tokens.

### What types of secrets are detected?

API keys (OpenAI, AWS, GitHub, Stripe, Slack, etc.), PEM private keys, JWTs, database connection strings, secret assignments (`password=`, `token=`), SSNs, credit card numbers, emails, phone numbers, and high-entropy tokens. See the [full list](./vault.md#what-gets-detected).

### What happens if I lose my vault key?

Vaulted secrets are permanently unrecoverable. Engram never has your key — that's the point of zero-knowledge encryption. Back up your key securely.

## Pricing

### Is there a free tier?

Pricing is not yet announced. For self-hosting, all Cloudflare services used (Workers, D1, Vectorize, Workers AI) have generous free tiers.

### What does self-hosting cost?

On Cloudflare's free tier: $0 for up to 100K requests/day, 5GB D1 storage, 5M vectors, and unlimited embeddings. For most early-stage projects, this is more than enough.
