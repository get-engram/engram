# Authentication

## API Keys

Engram uses API keys for authentication. Each key is tied to an organization and scopes all operations to that organization's data.

### Key Format

```
engram_sk_live_aBcDeFgHiJkLmNoPqRsTuVwXyZaBcDeF
```

- Prefix: `engram_sk_live_`
- Followed by 32 random characters
- Total length: 47 characters

### Usage

Pass your API key in the `Authorization` header:

```
Authorization: Bearer engram_sk_live_your_key_here
```

For MCP clients, this is set in the server configuration:

```json
{
  "mcpServers": {
    "engram": {
      "url": "https://mcp.getengram.app/mcp",
      "headers": {
        "Authorization": "Bearer engram_sk_live_your_key_here"
      }
    }
  }
}
```

### Security

- API keys are **hashed with SHA-256** before storage. Engram never stores your raw key.
- The full key is shown **once** at creation. Store it securely — it cannot be retrieved later.
- Only the first 20 characters (the **key prefix**) are stored for identification.
- Keys can have an **expiration date** and can be **revoked** at any time.

### Errors

| Status | Meaning |
|--------|---------|
| `401 Unauthorized` | Missing `Authorization` header, wrong format, or key not found |
| `403 Forbidden` | Key is expired or has been revoked |
