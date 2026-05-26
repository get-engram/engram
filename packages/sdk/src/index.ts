export { Engram } from "./client.js";
export { VaultManager } from "./vault-manager.js";
export { EngramError, AuthenticationError, NotFoundError, TimeoutError } from "./errors.js";
export { generateVaultKey } from "./vault.js";
export type {
  EngramConfig,
  MessageRole,
  MessageInput,
  Message,
  Conversation,
  SearchResult,
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
  NamedSecretMetadata,
} from "./types.js";
