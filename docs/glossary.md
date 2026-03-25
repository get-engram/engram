# Glossary

### Agent
An AI system (like Claude, a custom bot, or an autonomous workflow) that uses Engram to store and recall conversations.

### Agent ID
A string identifier for the agent that created a conversation. Used to filter conversations by agent via `list_conversations`. Example: `"support-bot-v2"`.

### API Key
A secret credential used to authenticate with Engram. Format: `engram_sk_live_` + 32 random characters. Each key is scoped to one organization.

### Chunk
A sliding-window text fragment created from a sequence of messages. Chunks are embedded into vectors for semantic search. Default: 5 messages per chunk, stride of 3, overlap of 2.

### Conversation
A container for an ordered sequence of messages. Has optional title, agent_id, tags, and metadata. Identified by a `conv_`-prefixed ID.

### Cosine Similarity
The metric used to compare vectors during search. A score of 1.0 means identical, 0.0 means unrelated. Engram search results are ranked by cosine similarity.

### D1
Cloudflare's serverless SQLite database. Engram uses D1 to store conversations, messages, chunks, API keys, and organizations.

### Embedding
A numerical representation (vector) of text that captures its semantic meaning. Engram uses 768-dimensional embeddings from the `bge-base-en-v1.5` model. Similar texts produce similar embeddings.

### MCP (Model Context Protocol)
An open standard for connecting AI models to external tools and data sources. Engram exposes its functionality as MCP tools, making it compatible with any MCP client.

### Message
An individual entry in a conversation. Has a role (user, assistant, system, or tool), content (stored verbatim), and a sequence number. Identified by a `msg_`-prefixed ID.

### Metadata
Arbitrary JSON data attached to conversations or messages. Not indexed for search — use tags for filterable attributes and metadata for supplementary context.

### Nanoid
A compact, URL-safe, unique ID generator. Engram uses nanoids with type prefixes (`org_`, `conv_`, `msg_`, `key_`, `chk_`) for readable, type-safe identifiers.

### Organization
The top-level tenant in Engram. All data is scoped to an organization. Each API key belongs to one organization. Data never leaks between organizations.

### Sequence
An integer that determines message ordering within a conversation. Starts at 1 and increments with each message. Deterministic — doesn't depend on timestamps.

### Streamable HTTP
The MCP transport protocol Engram uses. Each request is an independent HTTP POST with a JSON-RPC payload. No WebSocket or persistent connection needed.

### Stride
The number of messages the chunking window moves forward between chunks. With a stride of 3 and window of 5, consecutive chunks overlap by 2 messages.

### Tags
String labels attached to conversations for filtering. Stored as a JSON array. Searchable via exact match in `list_conversations` and `search`.

### Tenant Isolation
The guarantee that one organization's data is never accessible to another. Enforced at the database, vector search, and application layers.

### Tool (MCP)
A function exposed via MCP that an AI agent can call. Engram has 6 tools: `create_conversation`, `append_messages`, `search`, `get_conversation`, `list_conversations`, `delete_conversation`.

### Vectorize
Cloudflare's vector database. Engram uses Vectorize to store chunk embeddings and perform similarity search.

### Verbatim Storage
Engram's core principle: messages are stored exactly as sent, with no summarization, extraction, or compression. The original text is always retrievable.

### Window Size
The number of messages included in each chunk. Default: 5. A larger window captures more context per chunk but produces coarser search results.

### Workers AI
Cloudflare's inference platform. Engram uses it to generate embeddings with the `bge-base-en-v1.5` model at no cost.
