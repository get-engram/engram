# Product Hunt Draft

## Tagline (55 chars)

Long-term memory for AI agents — search every conversation

## Description

Engram gives your AI agents persistent memory. Every conversation you have with Claude Code, Cursor, or any MCP-compatible tool is captured verbatim and made searchable with semantic search. Ask your agent "what did we decide about the auth flow last week?" and it just knows.

Install the CLI via Homebrew or npm, start the background daemon, and it auto-captures your Claude Code transcripts with zero friction. Engram runs as an MCP server on Cloudflare Workers, so your agent can store and recall context natively — no copy-pasting, no manual notes.

Engram is open source (MIT), GDPR compliant, and has a free tier to get started. Self-host it or use the hosted version at getengram.app.

## Maker Comment

Hey everyone — I built Engram because I kept running into the same problem: I'd have a long, productive session with Claude Code, make a bunch of decisions, debug something tricky, figure out the right architecture... and then the next day, all of that context was gone. The agent had no idea what we'd discussed.

I tried keeping notes, pasting things into docs, even saving transcripts manually. None of it stuck. What I actually wanted was for my agent to just remember — the way a good coworker remembers the conversation you had yesterday.

So Engram captures your full conversations automatically and makes them searchable via semantic search. Your agent can query its own history through MCP. The first time Claude Code pulled up a decision we'd made three sessions ago without me prompting it, it felt like a genuine step change in how useful these tools are.

It's MIT licensed and open source. Would love your feedback — especially if you're using Claude Code or Cursor heavily and have felt this same pain.

## Topics/Tags

- Artificial Intelligence
- Developer Tools
- Open Source
- Productivity
- Command Line Tools
