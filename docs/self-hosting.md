# Self-Hosting

Engram runs entirely on Cloudflare's developer platform. You can deploy your own instance with a free Cloudflare account.

## Prerequisites

- [Node.js](https://nodejs.org) 18+
- [pnpm](https://pnpm.io) 9+
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)

## Setup

### 1. Clone and install

```bash
git clone https://github.com/get-engram/engram.git
cd engram
pnpm install
```

### 2. Authenticate with Cloudflare

```bash
wrangler login
```

### 3. Create D1 database

```bash
wrangler d1 create engram-db
```

Copy the `database_id` from the output and update `apps/mcp-server/wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "engram-db"
database_id = "your-database-id-here"
```

### 4. Apply migrations

```bash
# Local development
cd apps/mcp-server
npm run db:migrate:local

# Production
wrangler d1 migrations apply engram-db --remote
```

### 5. Create Vectorize index

```bash
wrangler vectorize create engram-vectors --dimensions=768 --metric=cosine
```

### 6. Generate an API key

```bash
cd apps/mcp-server
npm run seed
```

This outputs SQL statements to create an organization and API key. Run them against your D1 database:

```bash
wrangler d1 execute engram-db --remote --command="INSERT INTO ..."
```

Save the raw API key — it's shown once and cannot be retrieved.

### 7. Deploy

```bash
cd apps/mcp-server
wrangler deploy
```

Your Engram instance is now live at `https://engram-mcp-server.<your-subdomain>.workers.dev`.

## Local Development

```bash
# From the repo root
pnpm dev

# Or from apps/mcp-server
npm run dev
```

This starts a local server at `http://localhost:8787`. The `/health` endpoint returns service status.

To test with an MCP client, point it at `http://localhost:8787/mcp` with your API key.

## Running Tests

```bash
# All packages
pnpm test

# Just the MCP server
cd apps/mcp-server && npm test
```

## Type Checking

```bash
pnpm typecheck
```

## Infrastructure

| Service | What it does | Free tier limits |
|---------|-------------|-----------------|
| **Workers** | Runs the MCP server at the edge | 100K requests/day |
| **D1** | SQLite database for conversations & messages | 5GB storage |
| **Vectorize** | Vector search index for semantic search | 5M vectors |
| **Workers AI** | Generates embeddings (`bge-base-en-v1.5`) | Unlimited (free model) |
