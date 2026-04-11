# Show HN draft

## What Show HN is

"Show HN" is a Hacker News post category for showing the community something you built. It's the most valuable launch surface for a developer tool like Engram — HN readers are the exact audience (people building on MCP, Claude Desktop, Cursor, Codex) and a good Show HN can drive thousands of qualified signups.

**Rules of the format:**
- Title must start with `Show HN:`.
- Title should be plain, descriptive, no marketing adjectives. No "blazingly fast", no "revolutionary", no emoji.
- Body goes in the first comment, not the submission text. The submission text is the URL.
- OP is expected to reply to every top-level comment in the first 4–6 hours. Show up and answer questions — that's what converts the thread.
- Don't game the ranking. Don't ask friends to upvote (this gets the post flagged). Submit at a reasonable US-morning time (Tuesday–Thursday, 7–9am PT), share it organically afterward.

## Title candidates (pick one)

Best candidates, in priority order:

1. **`Show HN: Engram – Verbatim memory for AI agents over MCP`**
2. `Show HN: Engram – Persistent conversation memory for Claude Desktop, Cursor, Codex`
3. `Show HN: A hosted memory service for MCP agents (stores full transcripts, not summaries)`

Why #1 wins: "Verbatim" is the differentiator vs Mem0/MemGPT. "MCP" signals the audience. "AI agents" is more precise than "LLMs". It fits under HN's 80-char title limit.

## URL to submit

`https://getengram.app`

(Not the GitHub repo, not the docs. The landing page is what converts — it has the whitepaper link, the MCP endpoint, and the signup CTA.)

## First-comment body (paste as the first reply)

```
Hi HN, I'm the author. Engram is a memory service for AI agents — you plug it into any MCP-compatible client (Claude Desktop, Cursor, Windsurf, Zed, Codex, Claude Code) and your agent gets persistent, searchable memory across sessions.

The thing that makes it different from Mem0 / Zep / MemGPT / Supermemory:

- **It stores verbatim, not summaries.** What you write in is exactly what comes back, character-for-character. Mem0 and MemGPT extract facts and discard the original text, which works until the extractor misunderstands something, and then the signal is permanently gone. Engram keeps the original transcript (every message, every tool call, every tool result) and does semantic search on chunks of it.
- **It's MCP-native.** Any MCP client speaks to it with one line of config. No custom SDK, no framework lock-in — just `mcp.getengram.app/mcp` and your API key.
- **It's hosted.** Mem0 and Zep expect you to run your own vector store or self-host the whole stack. Engram is SaaS — you sign up and you get an API key. Built on Cloudflare Workers + D1 + Vectorize + Workers AI, so it's globally low-latency with no cold starts.

Why I built it: I'd been using Claude Code for real engineering work for months and kept losing context every time a session ended. The decisions, the debugging paths, the reasons we chose X over Y — all of it got dropped the moment the window closed. I tried building on top of the existing memory libraries and all of them wanted to summarize or extract. I wanted the exact conversation back. So I built one that keeps the exact conversation back.

Stack:
- Cloudflare Workers (Hono.js) for the MCP server
- D1 for structured storage (orgs, conversations, messages, chunks)
- Vectorize for the embedding index (`bge-base-en-v1.5`, 768-dim)
- Workers AI for embedding generation (same region as storage, no egress)
- Per-org isolation at the D1 and Vectorize namespace level

Free tier is 1,000 messages/month with unlimited conversations. Pro is $39/mo for 100k messages. Team is $49/seat/mo for 500k.

There's a whitepaper at https://getengram.app/whitepaper that walks through seven real use cases from dogfooding the product on this repo — the tl;dr is that verbatim conversation memory is the missing layer between unstructured chat logs and structured project state (issues, changelogs, standups, ADRs).

Happy to answer anything — architecture, pricing, why MCP, how the chunking works, comparisons with specific competitors, or how it fits into an existing agent workflow.
```

## Anticipated questions and answers (prep these before posting)

**Q: How is this different from Mem0?**
A: Mem0 runs an extractor that converts conversations into discrete "memories" (facts) and discards the original text. That's great when the fact is all you need. It's terrible when the extractor misinterprets nuance, because the original is gone. Engram never extracts — it chunks the original transcript and embeds the chunks. You always get back the exact text the agent said, with the context around it. Think of Engram as closer to "full-text search over your agent's history" than "fact database".

**Q: How is this different from just stuffing everything in a Postgres + pgvector?**
A: Nothing, structurally. You could build this yourself. What you're paying for is: the MCP wire protocol, the chunking heuristics, tenant isolation, the Cloudflare edge latency, the embedding pipeline, and the fact that it already works with Claude Desktop et al. out of the box. It's a 2-minute setup instead of a 2-week project.

**Q: Why Cloudflare Workers and not [$FAVORITE_RUNTIME]?**
A: Because D1 + Vectorize + Workers AI live in the same region as the compute, embeddings happen inline with no egress, and there are no cold starts. The write path (`append_messages` → chunk → embed → insert into D1 → upsert into Vectorize) is one network hop. On other stacks I'd be paying latency for each hop. I can defend this one pretty strongly.

**Q: What about privacy? Is my conversation data used for training?**
A: No. Engram stores your data in Cloudflare D1 + Vectorize, scoped to your organization. It's not used for any training of any model, including the embedding model (which is a static published model running on Workers AI). Per-org isolation is enforced at the database and vector index level — a query on org A can't return results from org B.

**Q: How do you handle tool calls and tool results?**
A: Messages have a role (`user` / `assistant` / `tool`) and optional `tool_call_id` + `tool_name` columns. Tool calls get indexed alongside the text, so you can search "that time the agent ran `grep` for the ESM build error" and get the exact tool result back. This is the thing that makes "project tracking" use cases work.

**Q: Is it open source?**
A: The MCP server is public on GitHub at `get-engram/engram`. The hosted service is the commercial offering. If you want to self-host, the docs have a self-hosting guide — you'll need Cloudflare Workers with D1 + Vectorize. The free tier exists specifically so you don't have to self-host unless you want to.

**Q: What happens if I exceed my quota?**
A: Writes are rate-limited at the MCP layer with a clear error. Reads keep working. You never silently drop data. We email you before you hit the wall.

**Q: What's chunking look like?**
A: Messages above a size threshold are split into overlapping semantic chunks (~400 tokens with 50-token overlap). Each chunk is embedded independently. On search, we hit Vectorize for the top-k chunks, then fetch the parent message and adjacent messages for context. That last part is what makes "give me the exact conversation around this hit" work.

**Q: Why `bge-base-en-v1.5` and not OpenAI's `text-embedding-3-small`?**
A: `bge-base-en-v1.5` runs on Workers AI, which means the embedding call is co-located with the D1 write and there's no network hop to OpenAI. Quality is competitive on retrieval benchmarks and it's free under Workers AI pricing. If enough users ask for multilingual or a bigger model, I'll add one.

**Q: Can I use this from $MY_LANGUAGE?**
A: If your agent speaks MCP, yes — MCP is language-agnostic. There's also a TypeScript SDK (`@getengram/sdk`) and a CLI (`@getengram/cli`) if you want to use it outside of an MCP client context.

## Timing and distribution

- **Submit:** Tuesday or Wednesday, ~7–9am PT. Avoid Mondays (busy week start) and weekends (low traffic).
- **Don't:** ask friends to upvote, post in r/mcp the same hour, cross-post the same title on Twitter before the thread has 30 minutes of organic traction.
- **Do:** have a tab open on the HN thread for 6 hours, reply within 15 min to every top-level comment, and don't get defensive if someone hates it.

## Post-post checklist

- [ ] Reply to every top-level comment with substance (not "thanks!")
- [ ] Monitor for any P0 bug reports and fix live
- [ ] If it hits the front page, have a blog post URL ready to drop in comments
- [ ] After 24h, share the HN link on X with the top comment quote
- [ ] After 72h, capture the signup delta and write a launch retro
