# Engram for Claude Code

Persistent, searchable memory. Conversations are stored verbatim and retrieved
by meaning — nothing is summarized away.

## Install

```
/plugin marketplace add get-engram/engram
/plugin install engram@engram
```

Then restart Claude Code. The first time a memory tool is used you'll be sent
through a browser sign-in; there is no API key to copy and no config file to
edit. Approve once and the connection persists.

## What you get

- `search` — semantic search across everything you've stored
- `create_conversation` / `append_messages` — save a conversation
- `get_conversation`, `list_conversations`, `delete_conversation`
- `memory_status` — usage against your plan

A bundled skill teaches Claude when to search and what's worth saving, so
memory accumulates without being asked.

## Accounts

A free account is created as part of sign-in; 10,000 messages of memory that
never expire. https://getengram.app for plans.
