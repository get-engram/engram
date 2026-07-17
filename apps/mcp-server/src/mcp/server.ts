import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCreateConversation } from "./tools/create-conversation.js";
import { registerAppendMessages } from "./tools/append-messages.js";
import { registerSearch } from "./tools/search.js";
import { registerGetConversation } from "./tools/get-conversation.js";
import { registerListConversations } from "./tools/list-conversations.js";
import { registerDeleteConversation } from "./tools/delete-conversation.js";
import { registerMemoryStatus } from "./tools/memory-status.js";
import { registerResolveVault } from "./tools/resolve-vault.js";
import { registerVaultSet } from "./tools/vault-set.js";
import { registerVaultGet } from "./tools/vault-get.js";
import { registerVaultList } from "./tools/vault-list.js";
import { registerVaultDelete } from "./tools/vault-delete.js";
import { registerManageSubscription } from "./tools/manage-subscription.js";
import { registerAdminMetrics } from "./tools/admin-metrics.js";
import { isExternalOAuthClient } from "./auth-kind.js";
import type { Env, AuthContext } from "../types.js";

// Surfaced to clients (ChatGPT, Claude, …) in the MCP `initialize` response so
// the model knows to use Engram for memory proactively, without being asked —
// and that it owns the conversation_id rather than asking the user for one.
const SERVER_INSTRUCTIONS = `Engram is persistent, searchable memory. Use it proactively, without waiting to be asked.

- Recall: at the start of a task, call \`search\` with a short summary of the user's request to surface relevant prior context, and use what you find.
- Store: when something worth remembering is established — a decision, preference, fact, or useful context — call \`append_messages\` with the relevant messages from the current conversation, verbatim. conversation_id is OPTIONAL — omit it to use the user's default memory; never ask the user for one. Use \`create_conversation\` first only to group a distinct topic, then reuse that id.
- "Remember this / save this chat": store the messages already in THIS conversation. You cannot retrieve the user's past or external conversations — so if they ask you to remember their whole history, save the current exchange, then tell them Engram records going forward and that they can bulk-import their full history by exporting their ChatGPT (or Claude) data and running \`engram import\` (see getengram.app/docs). Do not attempt to gather, reconstruct, or forward their entire chat history — you don't have access to it.
- "Remember everything from this point forward": treat this as standing consent — keep calling \`append_messages\` with the substantive turns as the conversation develops, without asking again. Confirm briefly each time so the user knows what was saved.
- "What do you remember about ___?": call \`search\` and answer strictly from the results — that shows what is actually stored, not what only exists in the current chat.
- "How full is my memory?" / plan or usage questions: call \`memory_status\` and show the user the bar line verbatim (e.g. [████████░░] 82%).
- Images and screenshots: Engram stores text. Write out what the image shows or means (names, facts, quotes), then store that text.
- Skip trivial chatter (greetings, acknowledgements). Storage is verbatim and searchable by meaning.`;

export function createMcpServer(env: Env, auth: AuthContext): McpServer {
  const server = new McpServer(
    {
      name: "Engram",
      version: "0.1.0",
    },
    { instructions: SERVER_INSTRUCTIONS },
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
