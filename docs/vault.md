# Secrets Vault

Engram's Secrets Vault provides two layers of secret protection:

1. **Automatic detection** — Secrets in conversation messages are detected, encrypted client-side, and replaced with vault tokens before transmission
2. **Named secrets manager** — Explicitly store and retrieve secrets by name, like GitHub Secrets or HashiCorp Vault

All secrets are encrypted **client-side** with AES-256-GCM before they ever leave your machine. Engram's server never sees plaintext.

## Why it matters

AI agents handle sensitive data constantly: API keys, database credentials, tokens, PII. Without protection, these end up stored in plain text in conversation history — searchable, readable, and one breach away from exposure.

Engram's vault solves this with **zero-knowledge encryption**: your secrets are encrypted with a key only you hold. The server stores opaque blobs. Even if the database were compromised, secrets remain encrypted.

## How it works

```
Your machine                              Engram server
─────────────                             ─────────────
Message: "Deploy with                     Receives:
  sk-ant-abc123... key"                     "Deploy with [VAULT:vlt_x7Kd...] key"
        │                                          │
        ▼                                          ▼
  1. Detect secrets                         Stores vault token
     (sk-ant-abc123...)                     + encrypted blob
  2. Encrypt with YOUR key                  (cannot decrypt)
     (AES-256-GCM)
  3. Replace with token
     [VAULT:vlt_x7Kd...]
  4. Send to Engram
```

On retrieval, the SDK fetches the encrypted blobs and decrypts them locally with your key.

## Quick start

### 1. Generate a vault key

```bash
# Generate and save to ~/.engram/vault-key
engram vault keygen --save

# Or generate and manage yourself
engram vault keygen
```

The key is a base64-encoded 32-byte AES-256 key. **Store it securely. If you lose it, vaulted secrets cannot be recovered.**

### 2. Configure the SDK

```typescript
import { Engram } from '@getengram/sdk'

const engram = new Engram({
  apiKey: process.env.ENGRAM_API_KEY!,
  vault: {
    encryptionKey: process.env.ENGRAM_VAULT_KEY!,
  },
})
```

### 3. Use normally — secrets are protected automatically

```typescript
// Secrets in message content are auto-detected and encrypted
await engram.store({
  conversationId: 'conv_abc',
  messages: [
    {
      role: 'user',
      content: 'Connect to postgres://admin:s3cret@db.example.com/prod',
    },
  ],
})
// Server receives: "Connect to [VAULT:vlt_x7Kd...]"
// The connection string is encrypted client-side
```

### 4. Decrypt on retrieval

```typescript
const { conversation, messages } = await engram.getConversation('conv_abc')

// Messages contain vault tokens: [VAULT:vlt_x7Kd...]
// Decrypt them back to plaintext:
const decrypted = await engram.resolveSecrets(messages)
// → "Connect to postgres://admin:s3cret@db.example.com/prod"
```

## Named secrets manager

Store, retrieve, and manage secrets by name — like GitHub Secrets or HashiCorp Vault, but with client-side encryption. Designed for AI agents that need access to credentials without exposing them.

### CLI usage (recommended)

Following GitHub Secrets' pattern, values can be piped via stdin to avoid shell history exposure:

```bash
# Store a secret (pipe from stdin — avoids shell history)
echo "postgres://admin:s3cret@db.example.com/prod" | engram vault set DATABASE_URL

# Or pass directly (appears in shell history)
engram vault set OPENAI_KEY "sk-abc123..."

# Or use --value flag
engram vault set STRIPE_KEY --value "sk_live_..."

# Retrieve a secret (decrypted locally)
engram vault get DATABASE_URL
# → postgres://admin:s3cret@db.example.com/prod

# Pipe to another command
engram vault get DATABASE_URL | pbcopy

# List all secrets (names only — never values)
engram vault list
# NAME            TYPE                 UPDATED
# DATABASE_URL    connection_string    2026-05-25
# OPENAI_KEY      api_key              2026-05-25
# STRIPE_KEY      api_key              2026-05-25
#
# 3 secret(s)

# Delete a secret permanently
engram vault delete DATABASE_URL
```

### SDK usage

```typescript
const engram = new Engram({
  apiKey: process.env.ENGRAM_API_KEY!,
  vault: { encryptionKey: process.env.ENGRAM_VAULT_KEY! },
})

// Store
await engram.vault.set('DATABASE_URL', 'postgres://admin:s3cret@db.example.com/prod')

// Retrieve (decrypted locally)
const url = await engram.vault.get('DATABASE_URL')
// → "postgres://admin:s3cret@db.example.com/prod"

// List (names and metadata only, never values)
const secrets = await engram.vault.list()
// → [{ name: 'DATABASE_URL', secretType: 'connection_string', ... }]

// Delete
await engram.vault.delete('DATABASE_URL')
```

### Using with Claude Code as a secrets manager

Add secrets to the vault:

```bash
echo "sk-abc123..." | engram vault set OPENAI_KEY
echo "postgres://..." | engram vault set DATABASE_URL
```

Then in your `CLAUDE.md`:

```markdown
## Secrets

Project secrets are stored in Engram's vault. When you need a credential:

1. Run `engram vault list` to see available secrets
2. Run `engram vault get SECRET_NAME` to retrieve a specific secret
3. NEVER hardcode secrets in code — always use the vault
4. NEVER store retrieved secrets in files — use them ephemerally

The vault decrypts secrets locally with ENGRAM_VAULT_KEY.
Secrets are never sent to or stored on remote servers in plaintext.
```

Claude Code will then use `engram vault get` to retrieve secrets on demand, keeping them out of the conversation history and codebase.

### MCP tools for agents

Agents can also manage secrets via MCP tools:

| Tool | Description |
|------|-------------|
| `vault_set` | Store a named secret (encrypted blob) |
| `vault_get` | Retrieve a named secret (encrypted blob — decrypted by SDK) |
| `vault_list` | List secret names and metadata (never values) |
| `vault_delete` | Delete a named secret permanently |

### Secret naming conventions

Follow environment variable naming conventions:

```
DATABASE_URL          # connection strings
OPENAI_KEY            # API keys
STRIPE_SECRET_KEY     # provider-specific keys
JWT_SIGNING_SECRET    # application secrets
AWS_ACCESS_KEY_ID     # cloud credentials
```

Names must match `^[A-Za-z_][A-Za-z0-9_.-]*$` (letters, numbers, underscores, dots, hyphens; must start with letter or underscore).

---

## Automatic secret detection in conversations

The vault also auto-detects and encrypts secrets found in conversation messages. This protects against accidental leakage — even if a user pastes a secret into a conversation, it's encrypted before transmission.

## CLI — key management

### Generate a key

```bash
# Print key to stdout
engram vault keygen

# Save to ~/.engram/vault-key (permissions 600)
engram vault keygen --save
```

### Check vault status

```bash
engram vault status
# Vault: configured (key at ~/.engram/vault-key)
# Key prefix: dGhpcyBp...
```

### Environment variable

```bash
export ENGRAM_VAULT_KEY="your-base64-key-here"
```

The CLI and SDK check `ENGRAM_VAULT_KEY` first, then fall back to `~/.engram/vault-key`.

### Automatic protection with CLI

When a vault key is configured, `engram store` automatically encrypts detected secrets:

```bash
# Secrets in the message are encrypted before sending
engram store -c conv_abc "Deploy key: sk-ant-api-abc123xyz..."
# Server receives: "Deploy key: [VAULT:vlt_...]"
```

## What gets detected

The vault detects and encrypts these secret types:

| Type | Examples |
|------|----------|
| **API keys** | OpenAI (`sk-...`), Anthropic (`sk-ant-...`), AWS (`AKIA...`), GitHub (`ghp_...`), Stripe (`sk_live_...`), Slack (`xoxb-...`), SendGrid (`SG....`), Twilio (`SK...`), npm (`npm_...`) |
| **Private keys** | PEM-encoded RSA, EC, DSA, OpenSSH private keys |
| **JWTs** | `eyJ...` tokens with header.payload.signature |
| **Connection strings** | `postgres://`, `mysql://`, `redis://`, `mongodb://`, `amqp://` |
| **Secret assignments** | `password=`, `secret=`, `api_key=`, `token=`, `client_secret=` patterns |
| **SSNs** | `123-45-6789` format |
| **Credit cards** | 13–19 digit card numbers |
| **Emails** | `user@example.com` |
| **Phone numbers** | US format with optional country code |
| **High-entropy tokens** | Hex strings (32+ chars), base64 strings (40+ chars) |

Detection runs from most specific to most generic, with deduplication to prevent overlapping matches.

## Architecture

### Encryption

- **Algorithm:** AES-256-GCM (authenticated encryption)
- **Key:** 32-byte key, base64-encoded (you generate and hold this)
- **IV:** Random 12-byte initialization vector per secret (stored alongside ciphertext)
- **Runtime:** Web Crypto API — works in Node.js 18+, browsers, and Cloudflare Workers

### Zero-knowledge server

The server stores:
- `id` — vault entry identifier (`vlt_...`)
- `encrypted_value` — base64-encoded ciphertext
- `iv` — base64-encoded initialization vector
- `secret_type` — what type of secret was detected (for analytics, not the value)
- `conversation_id` — which conversation owns this entry
- `organization_id` — tenant isolation

The server **never** stores or sees:
- The plaintext secret
- Your encryption key
- Any way to decrypt the data

### Data flow

**Write path (store):**

```
SDK detectSecrets(content)
  → For each secret:
      Generate vlt_ ID
      Encrypt with AES-256-GCM + random IV
      Replace in content with [VAULT:vlt_xxx]
  → Send to server:
      Modified content (with tokens)
      Encrypted vault entries (opaque blobs)
  → Server stores both
```

**Read path (resolve):**

```
SDK receives message with [VAULT:vlt_xxx] tokens
  → Extract vault IDs from content
  → Call resolve_vault tool to get encrypted blobs
  → Decrypt each blob locally with your key
  → Replace tokens with plaintext
  → Return decrypted content
```

## MCP tools

### append_messages (updated)

The `append_messages` tool now accepts an optional `vault_entries` parameter:

```json
{
  "conversation_id": "conv_abc",
  "messages": [
    {
      "role": "user",
      "content": "Use [VAULT:vlt_x7Kd...] for auth"
    }
  ],
  "vault_entries": [
    {
      "id": "vlt_x7Kd...",
      "encrypted_value": "base64-ciphertext",
      "iv": "base64-iv",
      "secret_type": "api_key"
    }
  ]
}
```

The SDK handles this automatically when vault is configured.

### resolve_vault

Retrieve encrypted vault entries by ID. Returns encrypted blobs — decryption happens client-side.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `vault_ids` | string[] | Yes | Vault entry IDs (max 50) |

**Response:**

```json
{
  "entries": [
    {
      "id": "vlt_x7Kd...",
      "encrypted_value": "base64-ciphertext",
      "iv": "base64-iv",
      "secret_type": "api_key",
      "conversation_id": "conv_abc",
      "created_at": "2026-05-25T10:00:00Z"
    }
  ],
  "total": 1
}
```

All vault access is audit-logged.

## Key management

### Generating keys

```bash
# CLI
engram vault keygen --save

# SDK
import { generateVaultKey } from '@getengram/sdk'
const key = await generateVaultKey()
```

### Storing keys

| Method | Best for |
|--------|----------|
| `~/.engram/vault-key` | Local development, single machine |
| `ENGRAM_VAULT_KEY` env var | CI/CD, containers, cloud deployments |
| Secrets manager (AWS SSM, 1Password, etc.) | Production, team environments |

### Key rotation

Currently, key rotation requires re-encrypting existing vault entries. A built-in rotation command is planned for a future release.

### Recovery

**There is no recovery mechanism.** Engram never has your key. If you lose the key, all vaulted secrets in your conversations are permanently unrecoverable. The conversation content still contains `[VAULT:vlt_...]` tokens, but they cannot be decrypted.

Back up your vault key in a secure location.

## Integration examples

### Claude Code

In `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "engram": {
      "type": "http",
      "url": "https://mcp.getengram.app/mcp",
      "headers": {
        "Authorization": "Bearer engram_sk_live_your_key"
      }
    }
  }
}
```

In your `CLAUDE.md`:

```markdown
## Engram Memory

You have access to Engram for persistent memory. When storing conversations
that contain secrets (API keys, credentials, connection strings), the SDK
encrypts them client-side before sending.

Environment: ENGRAM_VAULT_KEY is set — secrets are automatically protected.
```

### Custom agent with SDK

```typescript
import { Engram } from '@getengram/sdk'

const engram = new Engram({
  apiKey: process.env.ENGRAM_API_KEY!,
  vault: { encryptionKey: process.env.ENGRAM_VAULT_KEY! },
})

// Agent stores conversation — secrets auto-encrypted
await engram.store({
  conversationId,
  messages: agentMessages,
})

// Agent retrieves conversation — decrypt secrets
const { messages } = await engram.getConversation(conversationId)
const decrypted = await engram.resolveSecrets(messages)
```

## FAQ

**Q: What happens if I don't configure a vault key?**
Messages are stored as-is, with no secret detection or encryption. The server-side redaction fallback will mask obvious patterns, but client-side encryption is strongly recommended.

**Q: Does vault encryption slow things down?**
Negligibly. AES-256-GCM via Web Crypto is hardware-accelerated on modern systems. Encrypting a typical message adds < 1ms.

**Q: Can I use different vault keys for different conversations?**
Not with a single SDK instance. You'd need to create separate `Engram` clients with different vault configs.

**Q: Are vault entries deleted when I delete a conversation?**
Yes. Vault entries have a foreign key to conversations with `ON DELETE CASCADE`.

**Q: What about secrets in search results?**
Search results return chunk text which may contain `[VAULT:vlt_...]` tokens. Use `resolveSecrets()` to decrypt them.
