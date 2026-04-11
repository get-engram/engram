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

## Configuration File

Credentials are stored in `~/.engram/config.json`:

```json
{
  "apiKey": "engram_sk_live_...",
  "baseUrl": "https://mcp.getengram.app"
}
```

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
