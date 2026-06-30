import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCreateConversation } from "./tools/create-conversation.js";
import { registerAppendMessages } from "./tools/append-messages.js";
import { registerSearch } from "./tools/search.js";
import { registerGetConversation } from "./tools/get-conversation.js";
import { registerListConversations } from "./tools/list-conversations.js";
import { registerDeleteConversation } from "./tools/delete-conversation.js";
import { registerResolveVault } from "./tools/resolve-vault.js";
import { registerVaultSet } from "./tools/vault-set.js";
import { registerVaultGet } from "./tools/vault-get.js";
import { registerVaultList } from "./tools/vault-list.js";
import { registerVaultDelete } from "./tools/vault-delete.js";
import { registerManageSubscription } from "./tools/manage-subscription.js";
import type { Env, AuthContext } from "../types.js";

// Surfaced to clients (ChatGPT, Claude, …) in the MCP `initialize` response so
// the model knows to use Engram for memory proactively, without being asked —
// and that it owns the conversation_id rather than asking the user for one.
const SERVER_INSTRUCTIONS = `Engram is persistent, searchable memory for AI agents. Use it proactively, without waiting to be asked.

- At the start of a task or session, call \`search\` with a short summary of the user's request to recall relevant prior context, and use what you find.
- When something worth remembering is established — decisions, preferences, facts, project or personal context — persist it: call \`create_conversation\` once to get a conversation_id (you own this id; never ask the user for it), then \`append_messages\` to store the user's message and your reply verbatim. Reuse that same conversation_id for the rest of the session.
- Do not store trivial chatter (greetings, acknowledgements). Storage is verbatim and searchable by meaning.`;

export function createMcpServer(env: Env, auth: AuthContext): McpServer {
  const server = new McpServer(
    {
      name: "Engram",
      version: "0.1.0",
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  registerCreateConversation(server, env, auth);
  registerAppendMessages(server, env, auth);
  registerSearch(server, env, auth);
  registerGetConversation(server, env, auth);
  registerListConversations(server, env, auth);
  registerDeleteConversation(server, env, auth);
  registerResolveVault(server, env, auth);
  registerVaultSet(server, env, auth);
  registerVaultGet(server, env, auth);
  registerVaultList(server, env, auth);
  registerVaultDelete(server, env, auth);
  registerManageSubscription(server, env, auth);

  return server;
}
