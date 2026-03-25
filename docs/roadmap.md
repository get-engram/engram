# Roadmap

## Phase 1 — MCP Server MVP (current)

The foundation: a working MCP server with full conversation storage and semantic search.

- [x] Monorepo setup (pnpm workspaces + Turborepo)
- [x] Shared types, Zod schemas, and utilities
- [x] D1 database schema (5 tables + indexes)
- [x] Typed query helpers for all tables
- [x] MCP server with 6 tools
- [x] API key authentication (SHA-256 hashed)
- [x] Sliding-window message chunking
- [x] Embedding generation via Workers AI
- [x] Vectorize semantic search with org-scoped filtering
- [x] Tenant isolation at every layer
- [x] Comprehensive test suite
- [ ] Deploy to Cloudflare Workers
- [ ] Production API key provisioning

## Phase 2 — REST API and Operations

Management capabilities beyond the MCP protocol.

- [ ] REST API for API key management (create, list, revoke)
- [ ] Rate limiting per organization
- [ ] R2 integration for conversation exports
- [ ] Bulk operations (bulk delete, bulk export)
- [ ] Usage tracking and metering
- [ ] Webhook notifications (conversation created, messages appended)

## Phase 3 — Dashboard and Teams

A web interface for managing Engram without touching code.

- [ ] Dashboard UI (React on Cloudflare Pages)
- [ ] OAuth authentication (via WorkOS or Clerk)
- [ ] Team management (invite members, assign roles)
- [ ] Conversation browser — view and search conversations in the UI
- [ ] Analytics — message volume, search patterns, active agents
- [ ] API key management UI

## Future Considerations

- **Async embedding pipeline** — Move chunking/embedding to Cloudflare Queues to reduce append latency
- **Configurable chunking** — Let users tune window size and stride per organization
- **Multiple embedding models** — Support larger/multilingual models
- **Cross-conversation search** — Search with conversation-level context (not just chunk-level)
- **Conversation branching** — Fork conversations for A/B testing agent responses
- **Retention policies** — Automatic cleanup of old conversations by age or count
