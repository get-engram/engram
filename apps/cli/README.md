# @getengram/cli

Command-line interface for [Engram](https://getengram.app) — persistent memory for AI agents.

## Install

```bash
# npm
npm install -g @getengram/cli

# or run directly
npx @getengram/cli search "your query"
```

## Setup

```bash
# Authenticate
engram auth login engram_sk_live_YOUR_API_KEY

# Or use environment variable
export ENGRAM_API_KEY=engram_sk_live_YOUR_API_KEY
```

## Commands

### Authentication

```bash
engram auth login <key>    # Save API key
engram auth logout         # Remove credentials
engram auth status         # Show auth status
```

### Conversations

```bash
# List all conversations
engram conversations list
engram conversations list --agent my-agent --tags prod,deploy

# Create a conversation
engram conversations create --title "Deploy Log" --tags prod

# Get conversation with messages
engram conversations get conv_abc123

# Delete a conversation
engram conversations delete conv_abc123 --force
```

### Store Messages

```bash
# Store a message
engram store -c conv_abc123 "Deployed v2.1.0 to production"

# Store with specific role
engram store -c conv_abc123 --role assistant "Deploy complete"

# Store tool output
engram store -c conv_abc123 --role tool --tool deploy "Success: v2.1.0"

# Pipe from stdin
echo "log output here" | engram store -c conv_abc123 --file -

# Store from file
engram store -c conv_abc123 --file ./deploy.log
```

### Search

```bash
# Semantic search across all memory
engram search "when did we deploy v2"

# Limit results
engram search "error handling" --limit 5

# Search within a conversation
engram search "config change" --conversation conv_abc123

# Filter by tags
engram search "production issues" --tags prod,api
```

### Output Formats

Every command supports `--json` for machine-readable output:

```bash
engram conversations list --json
engram search "deploy" --json | jq '.results[0].score'
```

## Configuration

Credentials are stored in `~/.engram/config.json`.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ENGRAM_API_KEY` | API key (overrides saved config) |
| `ENGRAM_BASE_URL` | Custom endpoint (default: `https://mcp.getengram.app`) |

## Examples

### Log agent sessions

```bash
# Create a session
CONV=$(engram conversations create --title "Agent Run $(date +%F)" --json | jq -r '.conversationId')

# Store messages as the agent runs
engram store -c $CONV "User asked to refactor auth module"
engram store -c $CONV --role assistant "Analyzing auth module..."
engram store -c $CONV --role tool --tool code_review "Found 3 issues"

# Later, search across all sessions
engram search "auth module issues"
```

### Pipe build output

```bash
npm run build 2>&1 | engram store -c conv_builds --file -
```

### Export conversation as JSON

```bash
engram conversations get conv_abc123 --json > conversation.json
```

## License

MIT — [getengram.app](https://getengram.app)
