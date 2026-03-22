-- API keys lookup by hash
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_org ON api_keys(organization_id);

-- Conversations by org, agent, updated
CREATE INDEX IF NOT EXISTS idx_conversations_org ON conversations(organization_id);
CREATE INDEX IF NOT EXISTS idx_conversations_agent ON conversations(organization_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(organization_id, updated_at DESC);

-- Messages by conversation + sequence for ordered retrieval
CREATE INDEX IF NOT EXISTS idx_messages_conv_seq ON messages(conversation_id, sequence);
CREATE INDEX IF NOT EXISTS idx_messages_org ON messages(organization_id);

-- Chunks by conversation
CREATE INDEX IF NOT EXISTS idx_chunks_conv ON conversation_chunks(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chunks_org ON conversation_chunks(organization_id);
CREATE INDEX IF NOT EXISTS idx_chunks_vectorize ON conversation_chunks(vectorize_id);
