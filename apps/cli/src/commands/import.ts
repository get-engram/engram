import { readFile } from "node:fs/promises";
import { Engram, type MessageInput } from "@getengram/sdk";
import { green, dim, bold } from "../output.js";

/**
 * Import a ChatGPT data export into Engram.
 *
 * Get the file: ChatGPT → Settings → Data controls → Export data. You'll be
 * emailed a zip; inside is `conversations.json`. Point this command at it:
 *
 *   engram import ~/Downloads/chatgpt-export/conversations.json
 *   engram import conversations.json --dry-run      # preview, no writes
 *   engram import conversations.json --limit 50     # first 50 conversations
 *
 * Each ChatGPT conversation becomes an Engram conversation; messages are
 * stored verbatim and embedded for semantic search.
 */

interface ChatNode {
  id?: string;
  parent?: string | null;
  message?: {
    author?: { role?: string };
    content?: { content_type?: string; parts?: unknown[] };
    create_time?: number | null;
  } | null;
}

export interface ChatConversation {
  title?: string | null;
  create_time?: number | null;
  current_node?: string | null;
  mapping?: Record<string, ChatNode>;
}

const STORE_BATCH = 100;

/** Walk the export's node tree (current_node → root) into a chronological list. */
export function linearize(convo: ChatConversation): MessageInput[] {
  const mapping = convo.mapping ?? {};
  const chain: ChatNode[] = [];
  let nodeId: string | null | undefined = convo.current_node;
  const guard = new Set<string>();
  while (nodeId && mapping[nodeId] && !guard.has(nodeId)) {
    guard.add(nodeId);
    chain.push(mapping[nodeId]);
    nodeId = mapping[nodeId].parent;
  }
  chain.reverse();

  const out: MessageInput[] = [];
  for (const node of chain) {
    const m = node.message;
    if (!m) continue;
    const role = m.author?.role;
    if (role !== "user" && role !== "assistant") continue;
    if (m.content?.content_type !== "text") continue;
    const text = (m.content.parts ?? [])
      .filter((p): p is string => typeof p === "string")
      .join("\n")
      .trim();
    if (!text) continue;
    out.push({ role, content: text });
  }
  return out;
}

export async function importChatgpt(
  engram: Engram,
  args: string[],
  flags: Record<string, string>,
): Promise<void> {
  const file = args[0];
  if (!file) {
    console.error("Usage: engram import <conversations.json> [options]");
    console.error("\nOptions:");
    console.error("  --dry-run        Parse and report counts without writing");
    console.error("  --limit <n>      Import only the first <n> conversations");
    console.error("  --tag <name>     Add an extra tag to every imported conversation");
    console.error("\nGet the file from ChatGPT → Settings → Data controls → Export data.");
    process.exit(1);
  }

  const dryRun = "dry-run" in flags || "dryRun" in flags;
  const limit = flags.limit ? parseInt(flags.limit, 10) : Infinity;
  const extraTag = flags.tag;

  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch {
    console.error(`Could not read ${file}`);
    process.exit(1);
  }

  let convos: ChatConversation[];
  try {
    const parsed = JSON.parse(raw);
    // The export is an array; some tools wrap it as { conversations: [...] }.
    convos = Array.isArray(parsed) ? parsed : (parsed.conversations ?? []);
  } catch {
    console.error("Not valid JSON. Point at conversations.json from your ChatGPT export.");
    process.exit(1);
  }

  if (!Array.isArray(convos) || convos.length === 0) {
    console.error("No conversations found in the file.");
    process.exit(1);
  }

  const toImport = convos.slice(0, limit);
  console.log(
    `${bold("ChatGPT import")} ${dim(`(${toImport.length} of ${convos.length} conversations${dryRun ? ", dry run" : ""})`)}`,
  );

  let imported = 0;
  let messageTotal = 0;
  let skipped = 0;
  let failed = 0;

  for (const [i, convo] of toImport.entries()) {
    const title = (convo.title || "Untitled").slice(0, 200);
    const messages = linearize(convo);
    if (messages.length === 0) {
      skipped++;
      continue;
    }

    const label = `[${i + 1}/${toImport.length}] ${title} ${dim(`(${messages.length} msgs)`)}`;
    if (dryRun) {
      console.log(`  ${dim("would import")} ${label}`);
      imported++;
      messageTotal += messages.length;
      continue;
    }

    try {
      const tags = ["chatgpt-import", ...(extraTag ? [extraTag] : [])];
      const { conversationId } = await engram.createConversation({
        title,
        agentId: "chatgpt-import",
        tags,
        metadata: {
          source: "chatgpt-export",
          original_create_time: convo.create_time ?? null,
        },
      });
      for (let b = 0; b < messages.length; b += STORE_BATCH) {
        await engram.store({
          conversationId,
          messages: messages.slice(b, b + STORE_BATCH),
        });
      }
      console.log(`  ${green("✓")} ${label}`);
      imported++;
      messageTotal += messages.length;
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ ${label} — ${msg}`);
      // A message-limit error means the tier cap was hit; stop early rather
      // than hammering the API with the rest.
      if (/limit/i.test(msg)) {
        console.error(
          dim(
            "\nHit a plan limit. Upgrade at https://getengram.app/pricing to import the rest, then re-run (already-imported conversations will duplicate — clear them first if needed).",
          ),
        );
        break;
      }
    }
  }

  console.log(
    `\n${bold("Done.")} ${imported} imported, ${messageTotal} messages` +
      `${skipped ? `, ${skipped} empty skipped` : ""}` +
      `${failed ? `, ${failed} failed` : ""}.`,
  );
  if (dryRun) console.log(dim("Dry run — nothing was written. Re-run without --dry-run to import."));
}
