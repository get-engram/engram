# CLI Reference — @getengram/cli

Command-line interface for Engram. Store and search agent memory from your terminal.

## Install

```bash
npm install -g @getengram/cli
```

Or use without installing:

```bash
npx @getengram/cli search "your query"
```

## Authentication

```bash
# Login with API key (saved to ~/.engram/config.json)
engram auth login engram_sk_live_YOUR_KEY

# Check status
engram auth status

# Logout
engram auth logout
```

Or set the environment variable:

```bash
export ENGRAM_API_KEY=engram_sk_live_YOUR_KEY
```

## Commands

### engram conversations list

List all conversations.

```bash
engram conversations list
engram conversations list --agent my-bot --tags prod,api
engram conversations list --sort message_count --order desc
engram conversations list --limit 5 --json
```

| Flag | Description |
|------|-------------|
| `--agent <id>` | Filter by agent ID |
| `--tags <a,b>` | Filter by tags (comma-separated) |
| `--sort <field>` | Sort by: `created_at`, `updated_at`, `message_count` |
| `--order <dir>` | Sort direction: `asc`, `desc` |
| `--limit <n>` | Max results |
| `--json` | Output as JSON |

### engram conversations create

Create a new conversation.

```bash
engram conversations create --title "Deploy Log" --tags prod,deploy --agent deploy-bot
```

| Flag | Description |
|------|-------------|
| `--title <text>` | Conversation title |
| `--agent <id>` | Agent identifier |
| `--tags <a,b>` | Tags (comma-separated) |
| `--json` | Output as JSON |

### engram conversations get

Retrieve a conversation with all its messages.

```bash
engram conversations get conv_abc123
engram conversations get conv_abc123 --limit 50
engram conversations get conv_abc123 --json
```

### engram conversations delete

Delete a conversation and all its data.

```bash
engram conversations delete conv_abc123 --force
```

The `--force` flag is required to confirm deletion.

### engram store

Store a message in a conversation.

```bash
# Store text
engram store -c conv_abc "Deployed v2.1.0 to production"

# Specify role
engram store -c conv_abc --role assistant "Deploy successful"

# Tool output
engram store -c conv_abc --role tool --tool deploy "exit code 0"

# From stdin
echo "build output" | engram store -c conv_abc --file -

# From file
engram store -c conv_abc --file ./deploy.log
```

| Flag | Description |
|------|-------------|
| `-c, --conversation <id>` | Conversation ID (required) |
| `--role <role>` | Message role: `user`, `assistant`, `system`, `tool` (default: `user`) |
| `--tool <name>` | Tool name (for tool messages) |
| `--file <path>` | Read content from file (use `-` for stdin) |
| `--json` | Output as JSON |

### engram search

Semantic search across all stored conversations.

```bash
engram search "when did we deploy v2"
engram search "error handling" --limit 5
engram search "auth issues" --tags prod --conversation conv_abc
engram search "deploy" --json
```

| Flag | Description |
|------|-------------|
| `--limit <n>` | Max results (1–50, default: 10) |
| `--conversation <id>` | Limit to specific conversation |
| `--tags <a,b>` | Filter by tags |
| `--json` | Output as JSON |

Output shows relevance score, conversation ID, and matched text:

```
[80.4%] conv_Y4KAdWuDUTAobIAi3toSC seq 1–3
  [system]: Building Engram Phase 2...
  [assistant]: Codebase analysis complete...
  [user]: User wants npm and brew distribution...
```

### engram vault keygen

Generate a new AES-256 vault encryption key for client-side secret encryption.

```bash
# Print key to stdout
engram vault keygen

# Save to ~/.engram/vault-key (permissions 600)
engram vault keygen --save
```

It also prints the key's fingerprint, which `engram vault status` shows too. With `--save`, it shows none of the key itself.

With no key saved, `--save` first checks your vault. If it already holds secrets, they were saved with another key, which a new one can't decrypt, and the daemon would hold what it captures (see [the vault guide](./vault.md#a-key-that-doesnt-match-your-vault)). Then it saves nothing, and says how to put that key back, unless you add `--force`.

| Flag | Description |
|------|-------------|
| `--save` | Save key to `~/.engram/vault-key` |
| `--force` | Replace a key in the file (backed up first), or save a new key over a vault that holds secrets |

### engram vault save-key

Save the key in `ENGRAM_VAULT_KEY` to `~/.engram/vault-key` (permissions 600), where the daemon started at login reads it.

```bash
engram vault save-key

# The file holds a different key: replace it (the file's key is backed up first)
engram vault save-key --force
```

The daemon that `engram install` starts at login may not get your shell's variables: launchd never passes them on macOS, and systemd and Windows may not. With the key only in `ENGRAM_VAULT_KEY`, that daemon has no vault key, and your vault's secrets aren't removed from what it captures. `engram install`, `engram status` and `engram vault status` say so when `~/.engram/vault-key` doesn't hold the key in `ENGRAM_VAULT_KEY`.

It saves only a vault key (32 bytes, base64-encoded), and never replaces a different key without `--force`, nor a file it can't read.

A daemon already running reads the file again before it sends, so it uses the key saved there from its next send on, with no restart, unless it was started with `ENGRAM_VAULT_KEY` set, which it goes on using. `engram vault save-key` and `engram vault keygen --save` say which.

| Flag | Description |
|------|-------------|
| `--force` | Replace a different key in the file, after backing it up to `~/.engram/vault-key.bak-<time>` |

### engram vault set

Store a named secret. Value is encrypted client-side before transmission.

```bash
# Pipe from stdin (recommended — avoids shell history)
echo "postgres://admin:secret@db.example.com/prod" | engram vault set DATABASE_URL

# Pass as argument
engram vault set OPENAI_KEY "sk-abc123..."

# Pass with flag
engram vault set STRIPE_KEY --value "sk_live_..."
```

| Flag | Description |
|------|-------------|
| `--value <val>` | Secret value (alternative to positional arg or stdin) |

### engram vault get

Retrieve a named secret. Decrypted locally with your vault key.

```bash
engram vault get DATABASE_URL
# → postgres://admin:secret@db.example.com/prod

# Pipe to clipboard
engram vault get DATABASE_URL | pbcopy

# JSON output
engram vault get DATABASE_URL --json
```

| Flag | Description |
|------|-------------|
| `--json` | Output as JSON |

### engram vault list

List all named secrets. Shows names and metadata only — never values.

```bash
engram vault list
# NAME            TYPE                 UPDATED
# DATABASE_URL    connection_string    2026-05-25
# OPENAI_KEY      api_key              2026-05-25

engram vault list --json

# Which secrets decrypt with your vault key (values are never shown)
engram vault list --check
```

| Flag | Description |
|------|-------------|
| `--json` | Output as JSON |
| `--check` | Read each secret and say which don't decrypt with your vault key: saved with another. With `--json`, each has `decrypts`: `true`, `false`, or `null` when it couldn't be checked |

### engram vault delete

Delete a named secret permanently.

```bash
engram vault delete DATABASE_URL
```

### engram vault status

Check vault configuration status.

```bash
engram vault status
# Vault: configured (key at /Users/you/.engram/vault-key)
# Key fingerprint: 5e0f13c9

# With ENGRAM_VAULT_KEY set, and the file without it:
# Vault: configured (key in ENGRAM_VAULT_KEY)
# Key fingerprint: 5e0f13c9
#   ~/.engram/vault-key isn't there: a daemon started at login may not have this key.
#   To save it there, readable only by you: engram vault save-key
```

The fingerprint is the first 8 hex characters of the SHA-256 of the key's 32 bytes. It shows none of the key, and one key has one fingerprint on every machine, however it is written, so two machines with the same fingerprint have the same key. A key the SDK can't read shows `Vault: invalid key (not base64)`, or `(expected 32 bytes, got N)`, and no fingerprint.

### engram help

Show help text with all commands and options.

```bash
engram help
engram --help
```

### engram version

```bash
engram version
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ENGRAM_API_KEY` | API key (overrides `~/.engram/config.json`) | — |
| `ENGRAM_BASE_URL` | Custom Engram endpoint | `https://mcp.getengram.app` |
| `ENGRAM_VAULT_KEY` | Vault encryption key (base64, 32 bytes). Used over `~/.engram/vault-key`, but the daemon started at login reads the file: see `engram vault save-key` | — |

## Configuration File

Credentials are stored in `~/.engram/config.json`:

```json
{
  "apiKey": "engram_sk_live_...",
  "baseUrl": "https://mcp.getengram.app"
}
```

It also holds the folders excluded from capture (`engram exclude`) and whether you stopped capture (`engram stop`). If the file is there but can't be read (it isn't valid JSON after a hand edit, say), Engram doesn't guess: capture waits, so nothing from an excluded folder is sent and nothing is skipped, and commands that would save the file stop instead of replacing your key and exclusions. `engram status` says what is wrong. Once the file reads again, capture picks up where it stopped within 5 minutes. No file at all means no settings.

The background daemon reads the key and `baseUrl` together, every few seconds, so `engram auth login` or a new `baseUrl` takes effect without a restart. A different key or server is a different account: what was captured for one is sent only to its own server, with a key of its own account, and waits on this machine until then. While the file can't be read, the daemon sends nothing; it never falls back to the default server. `ENGRAM_API_KEY` or `ENGRAM_BASE_URL` set for the daemon stays fixed for its lifetime.

With both `ENGRAM_API_KEY` and `ENGRAM_BASE_URL` set, commands that only use the key and server run without the file.

## Scripting Examples

### Create and populate a session

```bash
CONV=$(engram conversations create --title "Build $(date +%F)" --json | jq -r '.conversationId')
npm run build 2>&1 | engram store -c $CONV --file -
npm test 2>&1 | engram store -c $CONV --role tool --tool test --file -
engram store -c $CONV --role assistant "Build and tests complete"
```

### Search and pipe to jq

```bash
engram search "deploy" --json | jq '.results[] | {score, text: .chunkText[:80]}'
```

### Export a conversation

```bash
engram conversations get conv_abc --json > conversation-backup.json
```

For the whole account, use the paged [export endpoint](api-reference.md#export) with your API key, or the dashboard's export download.
