# Changelog

All notable changes to Engram are documented here.

## 0.1.0 — 2026-03-23

Initial MVP release.

### Added

- **MCP Server** with 6 tools:
  - `create_conversation` — Create new conversations with title, tags, metadata
  - `append_messages` — Store verbatim messages with automatic chunking and embedding
  - `search` — Semantic search across conversations using vector similarity
  - `get_conversation` — Retrieve conversations with paginated messages
  - `list_conversations` — List and filter conversations by agent, tags, sort order
  - `delete_conversation` — Cascade delete conversations, messages, chunks, and vectors

- **Authentication** — API key auth with SHA-256 hashing, expiration, and revocation

- **Database** — D1 schema with 5 tables (organizations, api_keys, conversations, messages, conversation_chunks) and optimized indexes

- **Vector Search** — Cloudflare Vectorize integration with `bge-base-en-v1.5` embeddings (768 dimensions)

- **Sliding-Window Chunking** — Messages automatically chunked with window=5, stride=3 for overlapping search coverage

- **Tenant Isolation** — Organization-scoped data at every layer (D1, Vectorize, application)

- **Monorepo** — pnpm workspaces + Turborepo with 3 packages:
  - `@getengram/shared` — Types, Zod schemas, utilities
  - `@getengram/db` — D1 migrations and typed query helpers
  - `@getengram/mcp-server` — Deployable Cloudflare Worker

- **Test Suite** — ~95 tests covering schemas, chunking, ID generation, auth, DB queries, conversation service, and HTTP endpoints

- **Seed Script** — Generate test organizations and API keys for local development
