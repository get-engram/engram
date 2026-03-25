# Examples and Tutorials

End-to-end walkthroughs for common Engram workflows.

## Tutorial 1: Building an Agent with Persistent Memory

Give a Claude agent memory that persists across sessions using Engram.

### The Problem

You have a coding assistant. Every time you start a new conversation, it forgets everything — your preferences, your project context, past decisions. You spend the first few minutes re-explaining the same things.

### The Solution

Store every conversation in Engram. At the start of each new session, search for relevant prior context and inject it into the system prompt.

### Step 1: System Prompt

```
You have access to Engram, a persistent memory system. At the start of
each conversation:

1. Search Engram for context relevant to the user's first message
2. Use any relevant results to inform your responses
3. Store this conversation in Engram when it contains useful information

Always store conversations about:
- User preferences and workflow
- Technical decisions and their reasoning
- Project-specific knowledge
- Bug investigations and resolutions
```

### Step 2: First Session

User asks: "Set up a new Next.js project with our standard config."

The agent has no prior context, so it asks questions and stores the conversation:

```
create_conversation
  title: "Project setup preferences"
  tags: ["preferences", "setup"]

append_messages
  conversation_id: "conv_..."
  messages:
    - role: "user"
      content: "Set up a new Next.js project with our standard config"
    - role: "assistant"
      content: "What's your standard config? I'll remember it for next time."
    - role: "user"
      content: "Next.js 14 with App Router, TypeScript strict mode, Tailwind,
                pnpm, src/ directory, import alias @/. ESLint with our custom
                config from @acme/eslint-config."
    - role: "assistant"
      content: "Got it. Setting up now with those preferences..."
```

### Step 3: Future Session (Days Later)

User asks: "Start a new project for the billing dashboard."

The agent searches Engram first:

```
search
  query: "project setup preferences standard config"
  limit: 3
```

Returns the previous conversation with all the setup details. The agent already knows: Next.js 14, App Router, TypeScript strict, Tailwind, pnpm, `src/`, `@/` alias, `@acme/eslint-config`. No re-explaining needed.

---

## Tutorial 2: Searchable Support History

Store every customer support interaction for instant recall.

### Step 1: Log Conversations

When a support conversation ends, store it:

```
create_conversation
  title: "TICKET-4821: Double billing issue"
  agent_id: "support-agent"
  tags: ["support", "billing", "resolved"]
  metadata: {
    "customer_id": "cust_789",
    "ticket_id": "4821",
    "resolution": "refund_issued"
  }

append_messages
  conversation_id: "conv_..."
  messages:
    - role: "user"
      content: "I'm being charged twice for my Pro subscription"
    - role: "assistant"
      content: "I can see two active subscriptions on your account. It looks
                like a duplicate was created when you updated your payment
                method on March 15th. Let me cancel the duplicate and issue
                a refund for the extra charge."
    - role: "tool"
      content: '{"cancelled": "sub_duplicate", "refund": {"id": "ref_456", "amount": 29.00}}'
      tool_name: "cancel_and_refund"
    - role: "assistant"
      content: "Done! I've cancelled the duplicate subscription and issued a
                $29.00 refund. It should appear in 3-5 business days."
```

### Step 2: Instant Recall

The same customer contacts support again weeks later:

```
search
  query: "double charged subscription duplicate"
  tags: ["support"]
```

The agent finds the exact previous conversation — including the tool call showing the refund was issued, the amount, and the timeline. No need to look up the ticket system separately.

### Step 3: Pattern Recognition

Search across all support conversations to find patterns:

```
search
  query: "duplicate subscription payment method update"
  limit: 20
  tags: ["support"]
```

If multiple customers hit the same issue, you'll find all the conversations and can identify a systemic bug.

---

## Tutorial 3: Multi-Agent Knowledge Sharing

Two agents working on different parts of a project, sharing knowledge through Engram.

### Research Agent

Investigates a topic and stores findings:

```
create_conversation
  title: "Research: Redis vs Valkey for session storage"
  agent_id: "research-agent"
  tags: ["research", "infrastructure", "sessions"]

append_messages
  conversation_id: "conv_..."
  messages:
    - role: "user"
      content: "Evaluate Redis vs Valkey for our session storage needs"
    - role: "assistant"
      content: "After analysis, Valkey is the better choice for us because:
                1. It's fully open source (BSD license) — no licensing risk
                2. API-compatible with Redis — zero code changes
                3. AWS ElastiCache now defaults to Valkey — cheaper
                4. Our session patterns (simple GET/SET, TTL-based expiry)
                   don't need any Redis-specific features
                5. Community momentum — major contributors moved to Valkey

                The only reason to stay with Redis would be if we needed
                Redis Modules (RediSearch, RedisJSON), which we don't."
```

### Implementation Agent

A week later, the implementation agent needs to set up session storage:

```
search
  query: "session storage infrastructure recommendation"
  limit: 5
```

Finds the research agent's full analysis. Knows to use Valkey, knows why, and has all the reasoning. No duplicate research needed.

---

## Tutorial 4: Meeting Notes as Searchable Knowledge

Store team discussions so decisions don't get lost.

### After Each Meeting

```
create_conversation
  title: "Architecture Review — March 23, 2026"
  tags: ["meeting", "architecture", "backend"]
  metadata: {
    "attendees": ["alice", "bob", "carol"],
    "type": "architecture-review"
  }

append_messages
  conversation_id: "conv_..."
  messages:
    - role: "user"
      content: "Alice: Should we use GraphQL or REST for the new public API?"
    - role: "assistant"
      content: "Bob: REST. Our consumers are mostly mobile apps and simple
                integrations. GraphQL adds complexity we don't need yet.
                We can always add a GraphQL layer on top later.

                Carol: Agreed. Let's use REST with OpenAPI spec so we get
                auto-generated client libraries. We should version with
                URL prefixes (/v1/) not headers.

                Decision: REST with OpenAPI, URL-based versioning."
```

### Six Months Later

New engineer asks: "Why don't we use GraphQL?"

```
search
  query: "GraphQL vs REST API decision"
  tags: ["architecture"]
```

Returns the original meeting discussion with the full reasoning, who said what, and the final decision.

---

## Tutorial 5: Debugging Journal

Track debugging sessions so solutions aren't lost.

```
create_conversation
  title: "Debug: Memory leak in worker pool"
  agent_id: "dev-assistant"
  tags: ["debug", "performance", "worker-pool"]

append_messages
  conversation_id: "conv_..."
  messages:
    - role: "user"
      content: "Workers are slowly consuming more memory. Heap snapshots show
                growing Map instances in the connection pool."
    - role: "assistant"
      content: "Let me check the connection pool cleanup logic..."
    - role: "tool"
      content: '{"file": "src/pool.ts", "line": 47, "code": "this.connections.set(id, conn)"}'
      tool_name: "read_file"
    - role: "assistant"
      content: "Found it — line 47 adds connections to the map but the cleanup
                in the 'close' handler on line 82 only runs on graceful
                shutdown, not on connection error. Connections that error out
                are never removed from the map.

                Fix: add a .on('error') handler that calls this.connections.delete(id)"
    - role: "user"
      content: "That fixed it. Memory is stable now."
```

Next time the team sees memory growth in any pool-based system:

```
search
  query: "memory leak connection pool growing map"
```

Gets the exact diagnosis and fix immediately.
