import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCreateConversation } from "./tools/create-conversation.js";
import { registerAppendMessages } from "./tools/append-messages.js";
import { registerSearch } from "./tools/search.js";
import { registerGetConversation } from "./tools/get-conversation.js";
import { registerListConversations } from "./tools/list-conversations.js";
import { registerDeleteConversation } from "./tools/delete-conversation.js";
import { registerMemoryStatus } from "./tools/memory-status.js";
import { registerWhoami } from "./tools/whoami.js";
import { registerResolveVault } from "./tools/resolve-vault.js";
import { registerVaultSet } from "./tools/vault-set.js";
import { registerVaultGet } from "./tools/vault-get.js";
import { registerVaultList } from "./tools/vault-list.js";
import { registerVaultDelete } from "./tools/vault-delete.js";
import { registerManageSubscription } from "./tools/manage-subscription.js";
import { registerAdminMetrics } from "./tools/admin-metrics.js";
import { isExternalOAuthClient } from "./auth-kind.js";
import type { Env, AuthContext } from "../types.js";

// Surfaced to clients in the MCP `initialize` response. Directory policy
// (both Anthropic's and OpenAI's reviewers, Sept 2026): instructions and tool
// descriptions may describe what a tool does and when it applies — they must
// NOT contain imperatives aimed at the model (unprompted tool calls,
// "no permission-asking"), scripted reply wording, or marketing/upsell copy.
// The user (or the assistant, with the user's consent) decides when tools
// are called. Keep every sentence here descriptive, or the listing gets
// rejected again.
export const SERVER_INSTRUCTIONS = `Engram provides persistent, user-controlled memory: conversation content the user chooses to save, stored verbatim and searchable by meaning across their connected apps.

Tool applicability:
- \`search\`: applicable when previously saved context is relevant to the user's request, or when the user asks what is remembered about a topic. Results include a chunk_summary for choosing among matches; chunk_text or \`get_conversation\` provide full context. Answers about stored memory should come from search results, which reflect what is actually stored.
- \`append_messages\`: stores messages verbatim when the user asks to remember something ("remember this", "save this chat" — meaning messages from the current conversation). conversation_id is optional; when omitted, content is stored in the user's default memory. A request like "remember everything from this point forward" expresses the user's standing consent to save substantive turns as the conversation continues; a brief confirmation when saving keeps the user informed. Trivial chatter (greetings, acknowledgements) is not meaningful to store.
- \`create_conversation\`: groups content for a distinct topic under its own conversation id, which can then be reused for related saves.
- \`delete_conversation\`: permanently removes a stored conversation.
- \`memory_status\`: reports storage usage and plan state, for questions like "how full is my memory?".
- Engram stores text only; the content of an image can be stored as a written description.
- Engram has no access to conversations outside the ones stored in it: past or external chat history cannot be retrieved or reconstructed. Users can bulk-import exported history from their account dashboard.`;

// Secrets guidance differs by connection kind: OAuth connectors can't see
// the vault tools (app marketplaces prohibit credential collection), which
// previously read as "Engram has no vault" — models then either refused or,
// worse, saved secrets into searchable memory. Both variants make the vault's
// existence explicit and keep secrets out of append_messages.
const VAULT_INSTRUCTIONS_SHARED = `

Secrets: Engram includes a zero-knowledge encrypted vault, separate from memory. Memory (append_messages) is searchable, cloud-synced text that resurfaces in future context, so it is not a suitable place for passwords, API keys, tokens, or government IDs — the vault is the appropriate store for those.`;

export const VAULT_INSTRUCTIONS_OAUTH = `${VAULT_INSTRUCTIONS_SHARED}
The vault is not accessible from this connector (app-platform rules prohibit collecting credentials here). Secrets can be stored with the Engram CLI (\`engram vault set <NAME>\`), which encrypts the value on the user's machine (AES-256-GCM) before upload; the server never sees plaintext.`;

export const VAULT_INSTRUCTIONS_FIRST_PARTY = `${VAULT_INSTRUCTIONS_SHARED}
The vault tools (vault_set / vault_get / vault_list / resolve_vault) apply when the user asks to store or retrieve a secret. vault_set accepts values already encrypted client-side with the user's vault key (from \`engram vault keygen\`) — the server only stores ciphertext. Without the vault key, the Engram CLI (\`engram vault set <NAME>\`) handles encryption locally.`;

export function createMcpServer(env: Env, auth: AuthContext): McpServer {
  const instructions =
    SERVER_INSTRUCTIONS +
    (isExternalOAuthClient(auth)
      ? VAULT_INSTRUCTIONS_OAUTH
      : VAULT_INSTRUCTIONS_FIRST_PARTY);
  const server = new McpServer(
    {
      name: "Engram",
      version: "0.1.0",
    },
    { instructions },
  );

  // Core memory tools — available to every client (incl. OAuth-connected
  // apps like ChatGPT).
  registerCreateConversation(server, env, auth);
  registerAppendMessages(server, env, auth);
  registerSearch(server, env, auth);
  registerGetConversation(server, env, auth);
  registerListConversations(server, env, auth);
  registerDeleteConversation(server, env, auth);
  registerMemoryStatus(server, env, auth);
  registerWhoami(server, env, auth);

  // First-party-only tools. External OAuth clients (auth.apiKeyId is
  // "oauth:<client_id>") get the memory-only surface: the secrets vault
  // stores credentials (which app marketplaces like ChatGPT's prohibit
  // collecting) and manage_subscription is billing, not memory. API-key /
  // SDK callers — the user's own agents — keep the full toolset.
  if (!isExternalOAuthClient(auth)) {
    registerResolveVault(server, env, auth);
    registerVaultSet(server, env, auth);
    registerVaultGet(server, env, auth);
    registerVaultList(server, env, auth);
    registerVaultDelete(server, env, auth);
    registerManageSubscription(server, env, auth);
  }

  // Admin tools — only available when authenticated via ADMIN_SECRET.
  // Cross-org visibility for the business owner.
  if (auth.isAdmin) {
    registerAdminMetrics(server, env, auth);
  }

  return server;
}
