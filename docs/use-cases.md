# Use Cases

## Agent Memory Across Sessions

Most AI agents lose their memory when a conversation ends. With Engram, an agent can store every interaction and recall relevant context in future sessions.

```
Session 1:
  User: "I prefer TypeScript over JavaScript, and I use Vim keybindings."
  → Agent stores this in Engram

Session 47:
  User: "Set up a new project for me."
  → Agent searches Engram for user preferences
  → Finds the original conversation
  → Sets up a TypeScript project with Vim config
```

**How to implement:**

1. At the start of each session, create a conversation (or continue an existing one)
2. Append all messages as the conversation progresses
3. Before responding, search Engram for relevant prior context
4. Include search results in the agent's system prompt

## Support Ticket History

Store every support interaction verbatim. When a customer returns, search their full history — not a summary of it.

```
append_messages
  conversation_id: "conv_ticket_4821"
  messages:
    - role: "user"
      content: "I'm getting charged twice for my subscription"
    - role: "assistant"
      content: "I can see two active subscriptions on your account..."
    - role: "tool"
      content: '{"subscriptions": [{"id": "sub_a", "status": "active"}, ...]}'
      tool_name: "lookup_subscriptions"
```

Later, when the same customer calls back:

```
search
  query: "double charged subscription"
  tags: ["support"]
```

The agent gets back the exact conversation — including the tool call results — not a compressed summary like "customer had billing issue."

## Knowledge Base from Conversations

Turn internal conversations into a searchable knowledge base. Every Slack thread, standup, or design review can be stored and searched semantically.

```
create_conversation
  title: "Why we chose Postgres over MongoDB"
  tags: ["architecture", "database"]
  agent_id: "knowledge-capture"

append_messages
  messages:
    - role: "user"
      content: "We evaluated MongoDB for the new service but went with Postgres because..."
```

Six months later, a new engineer asks: "Why don't we use MongoDB?" Search finds the original discussion with all the reasoning.

## Multi-Agent Coordination

Multiple agents can share memory through the same Engram organization. Agent A stores what it learned; Agent B searches and finds it.

```
Agent A (research agent):
  create_conversation
    title: "Market research — Q1 competitors"
    agent_id: "research-agent"
    tags: ["research", "competitors"]

  append_messages
    messages: [... detailed findings ...]

Agent B (strategy agent):
  search
    query: "competitor pricing changes"
    tags: ["research"]

  → Finds Agent A's research with full context
```

Use `agent_id` to track which agent created each conversation. Use tags to organize by topic.

## Audit Trail

Engram's verbatim storage creates a complete audit trail of every AI interaction. Nothing is summarized or lost.

- **Compliance** — Regulators can review exactly what the AI said
- **Debugging** — Reproduce issues by replaying the exact conversation
- **Training** — Identify patterns in user interactions from real transcripts
- **Accountability** — Every tool call, every response, stored with sequence ordering

## Conversation Analytics

Use `list_conversations` to analyze patterns:

```
list_conversations
  agent_id: "support-bot"
  sort: "message_count"
  order: "desc"
  limit: 100
```

Find your longest support conversations. Search for common issues. Track which topics generate the most back-and-forth.

## Personal AI Memory

Give your personal AI assistant persistent memory across every tool you use — Claude Desktop, Cursor, CLI tools. All conversations funnel into the same Engram organization, searchable from anywhere.

```
From Claude Desktop:
  "Remember that the prod database password rotates every 90 days,
   last rotated on March 1st."

From Cursor, two weeks later:
  search: "database password rotation"
  → Gets back the exact conversation from Claude Desktop
```
