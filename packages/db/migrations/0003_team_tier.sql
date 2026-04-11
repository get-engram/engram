-- Add tier, billing, and email to organizations
ALTER TABLE organizations ADD COLUMN tier TEXT NOT NULL DEFAULT 'free';
ALTER TABLE organizations ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE organizations ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE organizations ADD COLUMN email TEXT;

-- Usage tracking per billing period
CREATE TABLE IF NOT EXISTS usage (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  period TEXT NOT NULL,  -- YYYY-MM format
  messages_stored INTEGER NOT NULL DEFAULT 0,
  searches_run INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  UNIQUE(organization_id, period)
);

-- Seats: users within an org
CREATE TABLE IF NOT EXISTS seats (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  invited_at TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at TEXT,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  UNIQUE(organization_id, email)
);

-- Webhook endpoints
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  url TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '[]',  -- JSON array: ["messages.appended", "conversation.created"]
  secret TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- Webhook delivery log
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_endpoint_id TEXT NOT NULL,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  status_code INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempted_at TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (webhook_endpoint_id) REFERENCES webhook_endpoints(id) ON DELETE CASCADE
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_usage_org_period ON usage(organization_id, period);
CREATE INDEX IF NOT EXISTS idx_seats_org ON seats(organization_id);
CREATE INDEX IF NOT EXISTS idx_seats_email ON seats(email);
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_org ON webhook_endpoints(organization_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint ON webhook_deliveries(webhook_endpoint_id);
CREATE INDEX IF NOT EXISTS idx_orgs_stripe_customer ON organizations(stripe_customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_email ON organizations(email);
