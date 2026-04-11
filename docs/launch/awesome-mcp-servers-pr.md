# PR: add Engram to awesome-mcp-servers

Target repo: [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers)
Target section: `### 🧠 Knowledge & Memory` (around line 1388 of `README.md`)

## Why this matters

- The list is the #1 place MCP users browse for memory servers — also mirrored on glama.ai/mcp/servers.
- The Knowledge & Memory section already has ~120 entries. Three of them are unrelated projects called "engram" (`Cartisien/engram-mcp`, `kael-bit/engram-rs`, `tstockham96/engram`). Our entry needs to differentiate on: **hosted SaaS**, **MCP-native** (not a library), **verbatim storage**, **free tier**.
- Insertion point is alphabetical-ish within the section — we place ours near the existing `engram` entries so reviewers see the differentiation clearly.

## How to submit

```bash
gh repo fork punkpeye/awesome-mcp-servers --clone --remote
cd awesome-mcp-servers
git checkout -b add-engram
# apply the diff below
git add README.md
git commit -m "Add Engram to Knowledge & Memory"
git push -u origin add-engram
gh pr create --title "Add Engram to Knowledge & Memory" --body-file pr-body.md
```

## The diff

Insert the following line immediately **after** the existing `Cartisien/engram-mcp` entry (currently around line 1426), so the three `engram`-named entries are grouped together and reviewers can see ours is the hosted/cloud version:

```diff
 - [Cartisien/engram-mcp](https://github.com/Cartisien/engram-mcp) [...] - Persistent semantic memory for AI agents. SQLite-backed, local-first, zero config. [...]
+- [get-engram/engram](https://github.com/get-engram/engram) 📇 ☁️ - Hosted memory service for AI agents. Stores **verbatim** conversation transcripts (every message, tool call, and tool result — not summaries) and makes them searchable via semantic search over `bge-base-en-v1.5` embeddings. MCP-native over Streamable HTTP, works with Claude Desktop, Cursor, Windsurf, Zed, and Claude Code. Built on Cloudflare Workers + D1 + Vectorize for low global latency. Free tier at [getengram.app](https://getengram.app).
 - [entanglr/zettelkasten-mcp](https://github.com/entanglr/zettelkasten-mcp) [...]
```

Legend emojis used:
- `📇` — TypeScript codebase
- `☁️` — Cloud service (hosted SaaS)

## PR title

```
Add Engram to Knowledge & Memory
```

## PR body

```markdown
Adds **Engram** ([get-engram/engram](https://github.com/get-engram/engram)) to the 🧠 Knowledge & Memory section.

**What it is:** a hosted memory service for AI agents, speaking MCP over Streamable HTTP. Unlike Mem0/MemGPT/Zep-style servers that extract and discard the original text, Engram stores **verbatim** conversation transcripts — every message, every tool call, every tool result — and makes them searchable via semantic search (`bge-base-en-v1.5`, 768-dim, on Cloudflare Workers AI).

**Why it's different from the other `engram`-named entries:**
- `Cartisien/engram-mcp` — local-first SQLite, Ollama embeddings.
- `kael-bit/engram-rs` — Rust single-binary with auto-decay/promotion.
- `tstockham96/engram` — local knowledge graph, LOCOMO-benchmarked.
- **This entry (`get-engram/engram`)** — fully hosted SaaS on Cloudflare's edge, free tier, no self-hosting required. Placed directly after `Cartisien/engram-mcp` so the three are grouped.

**Links:**
- Website: https://getengram.app
- Docs: https://getengram.app/docs
- MCP endpoint: https://mcp.getengram.app/mcp
- Whitepaper: https://getengram.app/whitepaper (agent-authored project tracking, seven use cases)

Follows the existing format conventions (TypeScript 📇, Cloud ☁️, alphabetical placement near siblings).
```

## Post-merge checklist

- [ ] Confirm entry landed and glama.ai/mcp/servers synced (usually within 24h).
- [ ] Add a link to the awesome-mcp-servers listing from our docs (`integrations.md` or `comparison.md`).
- [ ] Tweet / HN comment linking the listing once live.
