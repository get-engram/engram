# Contributing

## Getting Started

1. Fork the repository: [github.com/27Club/engram](https://github.com/27Club/engram)
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/engram.git
   cd engram
   ```
3. Install dependencies:
   ```bash
   pnpm install
   ```
4. Build all packages:
   ```bash
   pnpm build
   ```
5. Run tests:
   ```bash
   pnpm test
   ```

## Development Workflow

### Branch Naming

- `feat/description` — New features
- `fix/description` — Bug fixes
- `docs/description` — Documentation changes
- `refactor/description` — Code refactoring
- `test/description` — Test additions or changes

### Making Changes

1. Create a branch from `main`:
   ```bash
   git checkout -b feat/your-feature
   ```

2. Make your changes. The monorepo has three packages:
   - `packages/shared` — Types, schemas, utilities (no Cloudflare dependencies)
   - `packages/db` — Database migrations and query helpers
   - `apps/mcp-server` — The MCP server Worker

3. Run tests:
   ```bash
   pnpm test
   ```

4. Run type checking:
   ```bash
   pnpm typecheck
   ```

5. Build:
   ```bash
   pnpm build
   ```

### Submitting a Pull Request

1. Push your branch:
   ```bash
   git push -u origin feat/your-feature
   ```

2. Open a PR against `main` on GitHub

3. Include in your PR description:
   - What the change does
   - Why it's needed
   - How to test it

## Code Style

- **TypeScript** — Strict mode enabled. No `any` types unless absolutely necessary.
- **Imports** — Use `.js` extensions for relative imports (required by ES modules).
- **Naming** — camelCase for variables and functions, PascalCase for types and interfaces, UPPER_SNAKE_CASE for constants.
- **Error handling** — Return `null` or error objects rather than throwing exceptions in service functions.
- **Testing** — Write tests for new functionality. Use the mock helpers in `apps/mcp-server/src/__tests__/helpers.ts`.

## Project Structure

```
engram/
├── packages/
│   ├── shared/          # No dependencies on Cloudflare — pure TypeScript
│   │   ├── src/types/   # Interface definitions
│   │   ├── src/schemas/ # Zod validation schemas
│   │   └── src/utils/   # ID generation, chunking, auth hashing
│   └── db/
│       ├── migrations/  # SQL migration files
│       └── src/queries/ # Typed query helpers
└── apps/
    └── mcp-server/
        ├── src/
        │   ├── index.ts           # Hono app entry point
        │   ├── middleware/auth.ts  # API key validation
        │   ├── mcp/server.ts      # MCP server factory
        │   ├── mcp/tools/         # One file per tool
        │   └── services/          # Business logic
        └── scripts/seed.ts        # Test data generator
```

### Build Order

Turborepo handles this automatically, but for reference:

```
@engram/shared → @engram/db → @engram/mcp-server
```

Changes to `shared` require rebuilding `db` and `mcp-server`. Changes to `db` require rebuilding `mcp-server`. Changes to `mcp-server` are self-contained.

## Adding a New MCP Tool

1. Define the Zod schema in `packages/shared/src/schemas/index.ts`
2. Create the tool file in `apps/mcp-server/src/mcp/tools/your-tool.ts`
3. Add the service function in `apps/mcp-server/src/services/`
4. Register the tool in `apps/mcp-server/src/mcp/server.ts`
5. Add tests

## Adding a Database Migration

1. Create a new file in `packages/db/migrations/` with the next sequence number:
   ```
   0003_your_migration.sql
   ```
2. Write standard SQL (SQLite-compatible)
3. Add query helpers in `packages/db/src/queries/`
4. Test locally:
   ```bash
   cd apps/mcp-server
   npm run db:migrate:local
   ```

## Running Locally

```bash
# Start the dev server
cd apps/mcp-server
npm run dev

# Apply migrations to local D1
npm run db:migrate:local

# Generate a test org + API key
npm run seed
```

The server starts at `http://localhost:8787`. Test with the MCP Inspector:

```bash
npx @anthropic-ai/mcp-inspector
```
