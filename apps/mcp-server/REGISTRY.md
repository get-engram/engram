# MCP Registry listing

Live: **`app.getengram/engram`** on `registry.modelcontextprotocol.io`
(remote streamable-http `https://mcp.getengram.app/mcp`).

`server.json` in this directory mirrors the published manifest. **The file the
publisher actually reads is `~/.config/engram/mcp-registry/server.json`** —
keep them identical, and treat this copy as documentation rather than the
source of a publish.

## Why this file is worth guarding

It previously held a *different* manifest: name `io.github.debragail/engram`,
version `1.1.0`, and a remote declaring `Authorization` as a **required**
header. All three are wrong, and publishing them would actively break things:

- `io.github.debragail/engram` is a **deleted** listing (July 2026). It was
  removed because the registry enforces **one server per remote URL**, and it
  was squatting ours. Republishing it recreates the collision that took three
  version deletions to clear.
- A *required* auth header stops clients from discovering OAuth cleanly. The
  live manifest deliberately declares no headers so a client negotiates
  `/.well-known/oauth-protected-resource` instead of prompting for a key.

## Republish

The registry requires a new `version` on every publish.

```sh
cd ~/.config/engram/mcp-registry      # bump "version" first
HEX=$(/opt/homebrew/opt/openssl@3/bin/openssl pkey \
  -in ~/.config/engram/mcp-registry-key.pem -noout -text \
  | grep -A3 priv: | tail -n +2 | tr -d ' :\n')
mcp-publisher login http --domain getengram.app --private-key "$HEX"
mcp-publisher publish
```

Ed25519; LibreSSL cannot read the key, so the Homebrew openssl@3 path is
required. Domain auth is proved by the public key served at
`engram-web/public/.well-known/mcp-registry-auth` — if that file is removed
or the key rotated, login breaks.
