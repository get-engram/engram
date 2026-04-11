export interface Organization {
  id: string;
  name: string;
  tier: "free" | "pro" | "team" | "enterprise";
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApiKey {
  id: string;
  organization_id: string;
  key_hash: string;
  key_prefix: string;
  name: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

export interface Conversation {
  id: string;
  organization_id: string;
  title: string | null;
  agent_id: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  message_count: number;
  created_at: string;
  updated_at: string;
}

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface Message {
  id: string;
  conversation_id: string;
  organization_id: string;
  role: MessageRole;
  content: string;
  tool_call_id: string | null;
  tool_name: string | null;
  sequence: number;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface ConversationChunk {
  id: string;
  conversation_id: string;
  organization_id: string;
  chunk_text: string;
  start_sequence: number;
  end_sequence: number;
  vectorize_id: string;
  created_at: string;
}

export interface Usage {
  id: string;
  organization_id: string;
  period: string;
  messages_stored: number;
  searches_run: number;
  updated_at: string;
}

export interface Seat {
  id: string;
  organization_id: string;
  email: string;
  role: "owner" | "admin" | "member";
  invited_at: string;
  accepted_at: string | null;
}

export interface WebhookEndpoint {
  id: string;
  organization_id: string;
  url: string;
  events: string[];
  secret: string;
  active: boolean;
  created_at: string;
}

export interface WebhookDelivery {
  id: string;
  webhook_endpoint_id: string;
  event: string;
  payload: string;
  status_code: number | null;
  attempts: number;
  last_attempted_at: string | null;
  delivered_at: string | null;
  created_at: string;
}

export interface MessageInput {
  role: MessageRole;
  content: string;
  tool_call_id?: string;
  tool_name?: string;
  metadata?: Record<string, unknown>;
}

export interface SearchResult {
  chunk_id: string;
  conversation_id: string;
  chunk_text: string;
  score: number;
  start_sequence: number;
  end_sequence: number;
  messages: Message[];
}
