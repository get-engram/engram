// ── Client Configuration ──

export interface EngramConfig {
  /** API key (e.g. "engram_sk_live_...") */
  apiKey: string;
  /** Base URL for the Engram MCP endpoint. Defaults to https://mcp.getengram.app */
  baseUrl?: string;
  /** Request timeout in milliseconds. Defaults to 30000 */
  timeout?: number;
}

// ── Message Types ──

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface MessageInput {
  role: MessageRole;
  content: string;
  toolCallId?: string;
  toolName?: string;
  metadata?: Record<string, unknown>;
}

export interface Message {
  id: string;
  conversationId: string;
  organizationId: string;
  role: MessageRole;
  content: string;
  toolCallId: string | null;
  toolName: string | null;
  sequence: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}

// ── Conversation Types ──

export interface Conversation {
  id: string;
  organizationId: string;
  title: string | null;
  agentId: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

// ── Search Types ──

export interface SearchResult {
  chunkId: string;
  conversationId: string;
  chunkText: string;
  score: number;
  startSequence: number;
  endSequence: number;
  messages: Message[];
}

// ── Method Parameters ──

export interface CreateConversationParams {
  title?: string;
  agentId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface StoreParams {
  conversationId: string;
  messages: MessageInput[];
}

export interface SearchParams {
  query: string;
  limit?: number;
  conversationId?: string;
  tags?: string[];
}

export interface GetConversationParams {
  conversationId: string;
  messageLimit?: number;
  messageOffset?: number;
}

export interface ListConversationsParams {
  limit?: number;
  offset?: number;
  agentId?: string;
  tags?: string[];
  sort?: "created_at" | "updated_at" | "message_count";
  order?: "asc" | "desc";
}

// ── Method Responses ──

export interface CreateConversationResponse {
  conversationId: string;
}

export interface StoreResponse {
  appended: number;
  messageIds: string[];
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
}

export interface GetConversationResponse {
  conversation: Conversation;
  messages: Message[];
}

export interface ListConversationsResponse {
  conversations: Conversation[];
  total: number;
}

export interface DeleteConversationResponse {
  deleted: boolean;
}
