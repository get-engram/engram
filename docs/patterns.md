# Patterns and Best Practices

## Conversation Design

### One conversation per session

The simplest pattern: create a new conversation at the start of each agent session, append messages as they happen.

```
// Session start
create_conversation
  title: "Chat with user_123 — 2026-03-23"
  agent_id: "chat-agent"
  metadata: { "user_id": "user_123", "session_id": "sess_abc" }

// During the session
append_messages
  conversation_id: "conv_..."
  messages: [... new messages ...]
```

### One conversation per thread

For threaded contexts (support tickets, Slack threads, PR reviews), use one conversation per thread. Append messages over time as the thread grows.

```
// First message in thread
create_conversation
  title: "TICKET-4821: Billing discrepancy"
  tags: ["support", "billing"]
  metadata: { "ticket_id": "4821" }

// As new messages come in (could be hours or days apart)
append_messages
  conversation_id: "conv_..."
  messages: [... latest messages ...]
```

### One conversation per topic

Group related interactions by topic, even if they span multiple sessions.

```
create_conversation
  title: "Project: Auth service rewrite"
  tags: ["project", "auth"]
  agent_id: "dev-assistant"
```

Append to this conversation across multiple coding sessions. Search later by tag to find all auth-related context.

## Tagging Strategy

Tags are the primary way to organize and filter conversations. Use them consistently.

**Recommended tags:**

| Category | Examples |
|----------|---------|
| Domain | `support`, `engineering`, `sales`, `onboarding` |
| Priority | `critical`, `p1`, `p2` |
| Status | `resolved`, `open`, `escalated` |
| Feature | `billing`, `auth`, `search`, `api` |
| Type | `debug`, `planning`, `review`, `brainstorm` |

Tags are stored as JSON arrays and searched with exact matching.

## Efficient Message Batching

Append messages in batches rather than one at a time. Each `append_messages` call triggers chunking and embedding — batching reduces overhead.

```
// Good: batch append
append_messages
  conversation_id: "conv_..."
  messages:
    - role: "user", content: "..."
    - role: "assistant", content: "..."
    - role: "tool", content: "...", tool_name: "lookup"
    - role: "assistant", content: "..."

// Avoid: one message at a time (4x the embedding cost)
append_messages messages: [{ role: "user", ... }]
append_messages messages: [{ role: "assistant", ... }]
append_messages messages: [{ role: "tool", ... }]
append_messages messages: [{ role: "assistant", ... }]
```

## Search Patterns

### Contextual search before responding

Before generating a response, search for relevant prior context:

```
search
  query: "<user's current question>"
  limit: 5

// Include results in the agent's system prompt:
// "Here is relevant context from prior conversations: ..."
```

### Scoped search

Narrow searches to specific conversations or tags when you know the context:

```
// Search within a specific conversation
search
  query: "error handling"
  conversation_id: "conv_project_auth"

// Search within a topic
search
  query: "deployment process"
  tags: ["engineering", "devops"]
```

### Pagination for long conversations

Use `get_conversation` with pagination for conversations with many messages:

```
// First page
get_conversation
  conversation_id: "conv_..."
  message_limit: 100
  message_offset: 0

// Next page
get_conversation
  conversation_id: "conv_..."
  message_limit: 100
  message_offset: 100
```

## Metadata Conventions

The `metadata` field on conversations and messages accepts arbitrary JSON. Here are useful patterns:

**Conversation metadata:**
```json
{
  "user_id": "user_123",
  "session_id": "sess_abc",
  "source": "claude-desktop",
  "environment": "production"
}
```

**Message metadata:**
```json
{
  "model": "claude-sonnet-4-20250514",
  "token_count": 1847,
  "latency_ms": 2340,
  "tool_calls_count": 3
}
```

Metadata is stored as JSON but not currently indexed for search. Use tags for filterable attributes and metadata for supplementary context.

## Agent ID Conventions

Use consistent `agent_id` values to track which agent created each conversation:

```
support-bot-v2
research-agent
code-assistant
knowledge-capture
onboarding-flow
```

You can list all conversations for an agent:

```
list_conversations
  agent_id: "support-bot-v2"
  sort: "updated_at"
  order: "desc"
```
