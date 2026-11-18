# Engram

Engram is a memory service for AI agents. It stores complete, verbatim conversation transcripts and makes them searchable via semantic search.

## Project Structure

- `apps/mcp-server/` — Cloudflare Worker: MCP server and REST API (Hono.js)
- `apps/cli/` — the `engram` command line tool (`@getengram/cli`)
- `packages/sdk/` — TypeScript client (`@getengram/sdk`)
- `packages/db/` — D1 migrations and typed query helpers
- `packages/shared/` — Types, Zod schemas, utilities (ID generation, chunking, auth)
- `mcpb/` — Claude Desktop extension bundle
- `plugins/engram/` — Claude Code plugin

This repository is public. Keep real names, email addresses, account ids and
business figures out of code, comments, tests, commit messages, issues and
pull requests. Examples use made-up values on `example.com`.

## Development

```bash
pnpm install        # install deps
pnpm build          # build all packages
pnpm test           # run all tests
pnpm typecheck      # type check
```

MCP server dev:
```bash
cd apps/mcp-server
npm run dev                # local server on :8787
npm run db:migrate:local   # apply D1 migrations locally
npm run seed               # generate test org + API key
```

## Deployment

The MCP server is deployed as a Cloudflare Worker at `mcp.getengram.app`.

Merging to `main` deploys it. The `Main` workflow
(`.github/workflows/main.yml`) runs typecheck, tests and build, does a deploy
dry-run, applies any new D1 migrations, then runs `wrangler deploy` with
credentials held in the repository's secrets. Do not deploy from a laptop.

## Git Workflow

Always use: issue → branch → PR → merge. Never commit directly to main.

## Engram Memory

You have access to Engram as an MCP server. Use it to maintain persistent memory across sessions.

### On session start

Search Engram for context relevant to the current task:

```
search
  query: "<summary of what the user is asking about>"
  limit: 5
```

Include any relevant results in your working context — they contain prior conversations about this project, decisions made, bugs investigated, and user preferences.

### During the session

When significant work is done or important context is established, store it:

```
create_conversation
  title: "<concise description of what was discussed>"
  agent_id: "claude-code"
  tags: [<relevant tags like "engram", "bugfix", "feature", "architecture">]
  metadata: { "project": "engram", "branch": "<current branch if relevant>" }

append_messages
  conversation_id: "<the conversation ID>"
  messages:
    - role: "user"
      content: "<what the user asked>"
    - role: "assistant"
      content: "<what you did and why>"
```

### What to store

- Decisions and their reasoning ("we chose X because Y")
- Bug investigations and resolutions
- User preferences and workflow patterns
- Architecture discussions
- Anything you'd want to remember next session

### What NOT to store

- Routine file reads or searches (these are in git)
- Trivial exchanges ("hello", "thanks")
- Information already in the codebase or git history
