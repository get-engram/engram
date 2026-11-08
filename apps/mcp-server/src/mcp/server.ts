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
import { guardToolErrors } from "./tool-guard.js";
import { MAX_MESSAGES_PER_APPEND } from "@getengram/shared";
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
- \`search\`: applicable when previously saved context is relevant to the user's request, or when the user asks what is remembered about a topic. Results include a chunk_summary for choosing among matches; chunk_text or \`get_conversation\` provide full context. Search results reflect what is actually stored.
- \`append_messages\`: stores the specific content the user asks to remember ("remember this", "save my preference for X"), verbatim. It takes only the message or messages the user pointed at, not the conversation as a whole. conversation_id is optional; when omitted, content is stored in the user's default memory. Trivial chatter (greetings, acknowledgements) is not meaningful to store.
- \`create_conversation\`: groups content for a distinct topic under its own conversation id, which can then be reused for related saves.
- \`delete_conversation\`: permanently removes a stored conversation.
- \`memory_status\`: reports storage usage and plan state, for questions like "how full is my memory?".
- Engram stores text only; the content of an image can be stored as a written description.
- Engram has no access to conversations outside the ones stored in it: past or external chat history cannot be retrieved or reconstructed.`;

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

// Ceiling on the combined number of array elements and object members a
// single tools/call arguments payload may carry (`maxToolInputElements`,
// @modelcontextprotocol/sdk >= 1.32). The Worker caps the request body at
// 8 MB, which bounds bytes, not shape: 8 MB of JSON can hold ~4 million
// elements, and schema-validating a payload that size is a CPU-time sink
// per request. Sized from the largest legitimate call, a 200-message daemon
// batch (MAX_MESSAGES_PER_APPEND), at 500 elements per message: a real
// message is role/content plus a small metadata bag (`tools_used`, a few
// dozen entries at most). The SDK counts before Zod runs and refuses the
// call with InvalidParams, so an oversized payload never reaches a handler.
export const MAX_TOOL_INPUT_ELEMENTS = MAX_MESSAGES_PER_APPEND * 500;

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
    { instructions, maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS },
  );

  // Every tool registered below runs under the failure policy (engram#513):
  // a thrown D1/Vectorize/Stripe error is logged here and answered with a
  // generic isError result, never its raw message. Must precede the first
  // register* call — the guard wraps registration, not execution.
  guardToolErrors(server);

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
