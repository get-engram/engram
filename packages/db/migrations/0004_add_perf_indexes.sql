-- Composite index for search dedup (organization + conversation in one lookup)
CREATE INDEX IF NOT EXISTS idx_chunks_org_conv ON conversation_chunks(organization_id, conversation_id);

-- Chronological conversation listing
CREATE INDEX IF NOT EXISTS idx_conversations_created ON conversations(organization_id, created_at DESC);

-- Usage tier checks (organization + period)
CREATE INDEX IF NOT EXISTS idx_usage_org_period ON usage(organization_id, period);
