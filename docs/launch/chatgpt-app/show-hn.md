# Show HN — ChatGPT app launch

**Title:** `Show HN: Engram – give ChatGPT long-term memory you can take to Claude and Cursor`

> Post as a **text** Show HN (better discussion than a URL post). Post Tue–Thu, US morning, and stay to answer comments the first hour.

---

Engram is now a ChatGPT app (also works with Claude and Cursor). It gives ChatGPT durable, private memory that you own — and, importantly, memory that isn't trapped inside ChatGPT.

The problem: every AI tool keeps its own little memory, or none. You explain your project to ChatGPT on Monday, then Cursor knows nothing about it on Tuesday. You become the copy-paste layer between your own tools.

Engram is a single memory store that sits under all of them via MCP. Two things it does that I haven't seen combined elsewhere:

1. **Import your existing history.** Export your ChatGPT (or Claude) data, run `engram import`, and every past conversation is stored verbatim and searchable by meaning. Your back-catalog becomes queryable from any connected tool.

2. **Shared memory across tools.** Save something in ChatGPT, recall it in Claude or Cursor. Same memory, everywhere.

How capture works, honestly, because it differs per host:

- **ChatGPT** — you invoke it ("remember this," "search Engram for…"). ChatGPT gives connectors no per-turn hook, so an app can't silently record everything — and OpenAI's policy prohibits pulling your full chat log. So it's save-on-request + the bulk import above.
- **Claude Code / Cursor** — these run locally, so capture can be automatic and verbatim. For Claude Code the CLI runs a background daemon that captures every session.

Under the hood it's stored verbatim (no lossy summarization), chunked, and embedded for semantic search. The whole backend runs on Cloudflare — Workers for the MCP server, D1 for storage, Vectorize for search, Workers AI for embeddings.

Connect in ChatGPT: Settings → Apps & Connectors → add Engram (OAuth, no key to paste). Free tier is 1,000 messages/month; Pro is $39/mo.

Source is BSL-1.1; the SDK + CLI are MIT: https://github.com/get-engram/engram
Site: https://getengram.app

I'd love feedback — especially: what context do you find yourself re-explaining to your AI tools the most? And would "one memory across all of them" actually change how you work, or is per-tool memory enough?

---

## Accuracy notes
- BSL-1.1 (product) / MIT (SDK+CLI). Free tier 1,000 msgs/mo. $39 Pro.
- Do NOT claim ChatGPT auto-records everything — it's save-on-request + import.
- OK to say "ChatGPT app" now that it's live in the directory.
