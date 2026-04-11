import { Engram } from "@getengram/sdk";
import { json, table, green, red, dim } from "../output.js";

export async function listConversations(
  engram: Engram,
  args: string[],
  flags: Record<string, string>,
): Promise<void> {
  const result = await engram.listConversations({
    limit: flags.limit ? parseInt(flags.limit) : undefined,
    agentId: flags.agent,
    tags: flags.tags ? flags.tags.split(",") : undefined,
    sort: flags.sort as "created_at" | "updated_at" | "message_count" | undefined,
    order: flags.order as "asc" | "desc" | undefined,
  });

  if (flags.json !== undefined) {
    json(result);
    return;
  }

  console.log(`${result.total} conversation(s)\n`);
  table(
    result.conversations.map((c) => ({
      id: c.id,
      title: c.title ?? dim("(untitled)"),
      messages: c.messageCount,
      agent: c.agentId ?? "",
      updated: c.updatedAt.slice(0, 16),
    })),
    ["id", "title", "messages", "agent", "updated"],
  );
}

export async function createConversation(
  engram: Engram,
  args: string[],
  flags: Record<string, string>,
): Promise<void> {
  const result = await engram.createConversation({
    title: flags.title ?? args[0],
    agentId: flags.agent,
    tags: flags.tags ? flags.tags.split(",") : undefined,
  });

  if (flags.json !== undefined) {
    json(result);
    return;
  }

  console.log(green("✓ Created conversation"));
  console.log(`  ID: ${result.conversationId}`);
}

export async function getConversation(
  engram: Engram,
  args: string[],
  flags: Record<string, string>,
): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error("Usage: engram conversations get <conversation-id>");
    process.exit(1);
  }

  const result = await engram.getConversation({
    conversationId: id,
    messageLimit: flags.limit ? parseInt(flags.limit) : undefined,
  });

  if (flags.json !== undefined) {
    json(result);
    return;
  }

  const c = result.conversation;
  console.log(`${c.title ?? "(untitled)"} ${dim(`(${c.id})`)}`);
  if (c.agentId) console.log(`Agent: ${c.agentId}`);
  if (c.tags.length) console.log(`Tags: ${c.tags.join(", ")}`);
  console.log(`Messages: ${c.messageCount}\n`);

  for (const m of result.messages) {
    const role = m.role.padEnd(9);
    console.log(`  ${dim(`[${role}]`)} ${m.content}`);
  }
}

export async function deleteConversation(
  engram: Engram,
  args: string[],
  flags: Record<string, string>,
): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error("Usage: engram conversations delete <conversation-id>");
    process.exit(1);
  }

  if (flags.force === undefined) {
    console.log(`About to delete conversation ${id} and all its data.`);
    console.log("Use --force to skip this confirmation.");
    process.exit(1);
  }

  await engram.deleteConversation(id);
  console.log(green(`✓ Deleted ${id}`));
}
