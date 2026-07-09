# One Memory, Everywhere

**Engram is the memory that follows you across every AI. Save something in ChatGPT, recall it in Claude or Cursor.**

*Published July 8, 2026 · Get Engram Inc*

---

## Your memory is trapped in whichever app you were using

You explained your architecture to ChatGPT on Monday. On Tuesday you're in Cursor, and it has no idea that conversation ever happened. Wednesday you're back in Claude Code, re-explaining the same three constraints you already talked through twice.

Every AI tool you use keeps its own little memory — or no memory at all. ChatGPT remembers a few things inside ChatGPT. Cursor knows this repo, for this session. Claude Code starts every conversation from zero. None of them talk to each other. So *you* become the integration layer: copying context between tools, re-explaining decisions, and losing the reasoning the moment a session ends.

That's backwards. The conversation is the most valuable thing you produce with an AI — the place where the problem gets understood and the decision gets made. It shouldn't belong to one app. It should belong to *you*, and follow you wherever you go.

## Memory as a layer, not a feature

Engram is a single, persistent memory that sits underneath all your AI tools instead of inside one of them.

Connect it once, and every tool that speaks [MCP](https://modelcontextprotocol.io) — Claude Code, Claude Desktop, Cursor, Windsurf, ChatGPT, Codex — reads and writes the same memory. Something you save in one shows up in all of them. Ask any of them "what did we decide about the auth flow?" and the answer is there, even if the decision was made three weeks ago in a different app.

Two things make this actually work, not just sound nice:

**It's stored verbatim.** Engram doesn't summarize your conversations into lossy "memories." It keeps the full text and makes it searchable by meaning, so recall returns what was actually said — the real reasoning, not a paraphrase of it.

**It's yours and portable.** Your memory isn't locked to a vendor's account. It's one store you own, queryable from any client, exportable, and — because it lives behind MCP — future-proof against whatever tool you adopt next.

## How it works in each app — honestly

Every AI host is built differently, and we're straight with you about what each one can do. This is a feature, not fine print: knowing the difference is how you get the most out of it.

**Claude Code & Cursor — automatic.** These tools run on your machine and expose your session to a local Engram agent. Memory capture is automatic and complete: every message is saved verbatim as you work, with zero ceremony. This is the full "it just remembers" experience.

**ChatGPT — you invoke it, plus one-time import.** ChatGPT is a hosted app with strong guardrails, so Engram works two ways there. Say *"remember this"* or *"save that to Engram,"* and it's stored forever and searchable everywhere else. And you can bring your entire back-catalog in one move: export your ChatGPT history and run `engram import` — all of it becomes part of your searchable memory. (ChatGPT can't silently record everything in the background — no app can, by OpenAI's design — so Engram is honest about that instead of pretending otherwise.)

The payoff is the same regardless of where a memory came from: **once it's in Engram, it's available from every connected tool.** Save in ChatGPT, recall in Cursor. Decide in Claude Code, reference in ChatGPT. The memory follows you; the app is just a window into it.

## Why "everywhere" is the whole point

A memory that only works in one tool isn't memory — it's a session. The value compounds precisely *because* it crosses apps:

- The research you did in ChatGPT is in context when you start building in Cursor.
- The bug you root-caused in Claude Code is recallable when a teammate asks about it in a different tool next month.
- Your preferences, your project's decisions, the "why" behind past choices — established once, present everywhere, never re-explained.

You stop being the copy-paste bridge between your tools. Your AIs start sharing a brain.

## Get started

1. **Get a key** at [getengram.app](https://getengram.app).
2. **Connect your tools** — add the Engram MCP server to Claude Code, Cursor, ChatGPT, or any MCP client (guides at [getengram.app/docs](https://getengram.app/docs)).
3. **Bring your history** — `engram import` your existing ChatGPT or Claude export so day one starts with everything you've already said.

Then just work. Save something in one place, recall it in another. One memory, everywhere.

---

*Engram is open source (MIT) and available hosted at [getengram.app](https://getengram.app) or self-hosted. Persistent, verbatim, searchable memory for every AI you use.*
