import { McpTransport } from "./transport.js";
import { EngramError } from "./errors.js";
import {
  processContent,
  resolveContent,
  generateVaultKey,
  type VaultConfig,
  type VaultEntry,
} from "./vault.js";
import { VaultManager } from "./vault-manager.js";
import type {
  EngramConfig,
  CreateConversationParams,
  CreateConversationResponse,
  StoreParams,
  StoreResponse,
  SearchParams,
  SearchResponse,
  GetConversationParams,
  GetConversationResponse,
  ListConversationsParams,
  ListConversationsResponse,
  DeleteConversationResponse,
  Conversation,
  Message,
  SearchResult,
} from "./types.js";

const DEFAULT_BASE_URL = "https://mcp.getengram.app";
const DEFAULT_TIMEOUT = 30_000;

/**
 * Engram SDK client. Provides typed access to Engram's persistent memory API.
 *
 * @example
 * ```typescript
 * const engram = new Engram({ apiKey: process.env.ENGRAM_API_KEY! })
 *
 * const { conversationId } = await engram.createConversation({ title: "My Chat" })
 *
 * await engram.store({
 *   conversationId,
 *   messages: [
 *     { role: "user", content: "Hello" },
 *     { role: "assistant", content: "Hi there!" },
 *   ],
 * })
 *
 * const { results } = await engram.search({ query: "greeting" })
 * ```
 */
export class Engram {
  private transport: McpTransport;
  private vaultConfig: VaultConfig | null;

  /**
   * Named secrets manager. Store, retrieve, list, and delete
   * named secrets with client-side encryption.
   *
   * Requires vault to be configured. Access via `engram.vault`.
   *
   * @example
   * ```typescript
   * await engram.vault.set('DATABASE_URL', 'postgres://...')
   * const url = await engram.vault.get('DATABASE_URL')
   * const secrets = await engram.vault.list()
   * await engram.vault.delete('DATABASE_URL')
   * ```
   */
  get vault(): VaultManager {
    if (!this.vaultConfig) {
      throw new EngramError(
        "Vault is not configured. Pass vault.encryptionKey in the Engram constructor."
      );
    }
    return new VaultManager(this.transport, this.vaultConfig);
  }

  /**
   * Generate a new AES-256 vault encryption key.
   * Returns a base64-encoded 32-byte key. Store this securely —
   * Engram never sees it.
   */
  static generateVaultKey = generateVaultKey;

  constructor(config: EngramConfig) {
    if (!config.apiKey) {
      throw new EngramError("apiKey is required");
    }

    const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const timeout = config.timeout ?? DEFAULT_TIMEOUT;

    this.transport = new McpTransport(baseUrl, config.apiKey, timeout);
    this.vaultConfig = config.vault ?? null;
  }

  /**
   * Create a new conversation.
   */
  async createConversation(
    params: CreateConversationParams = {},
  ): Promise<CreateConversationResponse> {
    const args: Record<string, unknown> = {};
    if (params.title !== undefined) args.title = params.title;
    if (params.agentId !== undefined) args.agent_id = params.agentId;
    if (params.tags !== undefined) args.tags = params.tags;
    if (params.metadata !== undefined) args.metadata = params.metadata;

    const raw = await this.transport.callTool("create_conversation", args);
    const data = JSON.parse(raw);
    return { conversationId: data.conversation_id };
  }

  /**
   * Store messages in a conversation. Messages are stored verbatim and
   * automatically chunked + embedded for semantic search.
   *
   * When vault is configured, secrets are detected and encrypted
   * client-side before transmission. The server stores only encrypted
   * blobs and vault reference tokens.
   */
  async store(params: StoreParams): Promise<StoreResponse> {
    let allVaultEntries: VaultEntry[] = [];

    const messages = await Promise.all(
      params.messages.map(async (m) => {
        let content = m.content;

        // Client-side vault: detect & encrypt secrets before sending
        if (this.vaultConfig) {
          const processed = await processContent(content, this.vaultConfig);
          content = processed.content;
          allVaultEntries.push(...processed.vaultEntries);
        }

        const msg: Record<string, unknown> = { role: m.role, content };
        if (m.toolCallId !== undefined) msg.tool_call_id = m.toolCallId;
        if (m.toolName !== undefined) msg.tool_name = m.toolName;
        if (m.metadata !== undefined) msg.metadata = m.metadata;
        return msg;
      })
    );

    const args: Record<string, unknown> = {
      conversation_id: params.conversationId,
      messages,
    };

    if (allVaultEntries.length > 0) {
      args.vault_entries = allVaultEntries.map((e) => ({
        id: e.id,
        encrypted_value: e.encrypted_value,
        iv: e.iv,
        secret_type: e.secret_type,
      }));
    }

    const raw = await this.transport.callTool("append_messages", args);
    const data = JSON.parse(raw);
    return {
      appended: data.appended,
      messageIds: data.message_ids,
    };
  }

  /**
   * Resolve vault tokens in message content back to plaintext secrets.
   * Fetches encrypted blobs from the server and decrypts client-side.
   * Requires vault to be configured.
   */
  async resolveSecrets(messages: Message[]): Promise<Message[]> {
    if (!this.vaultConfig) {
      throw new EngramError(
        "Vault is not configured. Pass vault.encryptionKey in the Engram constructor."
      );
    }

    // Collect all vault IDs from message content
    const vaultIdSet = new Set<string>();
    const vaultTokenRegex = /\[VAULT:(vlt_[A-Za-z0-9_-]+)\]/g;
    for (const msg of messages) {
      let match: RegExpExecArray | null;
      while ((match = vaultTokenRegex.exec(msg.content)) !== null) {
        vaultIdSet.add(match[1]);
      }
    }

    if (vaultIdSet.size === 0) return messages;

    // Fetch encrypted entries from server
    const raw = await this.transport.callTool("resolve_vault", {
      vault_ids: [...vaultIdSet],
    });
    const data = JSON.parse(raw);
    const entries: Array<{ id: string; encrypted_value: string; iv: string }> =
      data.entries ?? [];

    // Decrypt and replace in each message
    return Promise.all(
      messages.map(async (msg) => ({
        ...msg,
        content: await resolveContent(
          msg.content,
          entries,
          this.vaultConfig!
        ),
      }))
    );
  }

  /**
   * Semantic search across stored conversations.
   */
  async search(params: SearchParams): Promise<SearchResponse> {
    const args: Record<string, unknown> = { query: params.query };
    if (params.limit !== undefined) args.limit = params.limit;
    if (params.conversationId !== undefined)
      args.conversation_id = params.conversationId;
    if (params.tags !== undefined) args.tags = params.tags;
    if (params.snippetChars !== undefined)
      args.snippet_chars = params.snippetChars;

    const raw = await this.transport.callTool("search", args);
    const data = JSON.parse(raw);
    return {
      results: (data.results ?? []).map(mapSearchResult),
      total: data.total ?? 0,
    };
  }

  /**
   * Get a conversation with its messages. Supports pagination.
   */
  async getConversation(
    params: string | GetConversationParams,
  ): Promise<GetConversationResponse> {
    const p = typeof params === "string" ? { conversationId: params } : params;

    const args: Record<string, unknown> = {
      conversation_id: p.conversationId,
    };
    if (p.messageLimit !== undefined) args.message_limit = p.messageLimit;
    if (p.messageOffset !== undefined) args.message_offset = p.messageOffset;

    const raw = await this.transport.callTool("get_conversation", args);
    const data = JSON.parse(raw);
    return {
      conversation: mapConversation(data.conversation),
      messages: (data.messages ?? []).map(mapMessage),
    };
  }

  /**
   * List conversations with filtering and sorting.
   */
  async listConversations(
    params: ListConversationsParams = {},
  ): Promise<ListConversationsResponse> {
    const args: Record<string, unknown> = {};
    if (params.limit !== undefined) args.limit = params.limit;
    if (params.offset !== undefined) args.offset = params.offset;
    if (params.agentId !== undefined) args.agent_id = params.agentId;
    if (params.tags !== undefined) args.tags = params.tags;
    if (params.sort !== undefined) args.sort = params.sort;
    if (params.order !== undefined) args.order = params.order;

    const raw = await this.transport.callTool("list_conversations", args);
    const data = JSON.parse(raw);
    return {
      conversations: (data.conversations ?? []).map(mapConversation),
      total: data.total ?? 0,
    };
  }

  /**
   * Delete a conversation and all its messages, chunks, and embeddings.
   */
  async deleteConversation(
    conversationId: string,
  ): Promise<DeleteConversationResponse> {
    const raw = await this.transport.callTool("delete_conversation", {
      conversation_id: conversationId,
    });
    const data = JSON.parse(raw);
    return { deleted: data.deleted };
  }
}

// ── Response Mappers (snake_case → camelCase) ──

function mapConversation(raw: Record<string, unknown>): Conversation {
  return {
    id: raw.id as string,
    title: (raw.title as string) ?? null,
    agentId: (raw.agent_id as string) ?? null,
    tags: (raw.tags as string[]) ?? [],
    metadata: (raw.metadata as Record<string, unknown>) ?? {},
    messageCount: (raw.message_count as number) ?? 0,
    createdAt: raw.created_at as string,
    updatedAt: raw.updated_at as string,
  };
}

function mapMessage(raw: Record<string, unknown>): Message {
  return {
    id: raw.id as string,
    conversationId: raw.conversation_id as string,
    role: raw.role as Message["role"],
    content: raw.content as string,
    toolCallId: (raw.tool_call_id as string) ?? null,
    toolName: (raw.tool_name as string) ?? null,
    sequence: raw.sequence as number,
    metadata: (raw.metadata as Record<string, unknown>) ?? {},
    createdAt: raw.created_at as string,
  };
}

function mapSearchResult(raw: Record<string, unknown>): SearchResult {
  return {
    chunkId: raw.chunk_id as string,
    conversationId: raw.conversation_id as string,
    chunkText: raw.chunk_text as string,
    score: raw.score as number,
    startSequence: raw.start_sequence as number,
    endSequence: raw.end_sequence as number,
  };
}
