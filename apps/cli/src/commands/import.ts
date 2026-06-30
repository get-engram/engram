import { readFile } from "node:fs/promises";
import { Engram, type MessageInput } from "@getengram/sdk";
import { green, dim, bold } from "../output.js";

/**
 * Import a ChatGPT or Claude data export into Engram. The format is
 * auto-detected from the file.
 *
 *   - ChatGPT: Settings → Data controls → Export data → `conversations.json`
 *   - Claude:  Settings → Account → Export data → `conversations.json`
 *
 *   engram import ~/Downloads/conversations.json
 *   engram import conversations.json --dry-run      # preview, no writes
 *   engram import conversations.json --limit 50     # first 50 conversations
 *
 * Each source conversation becomes an Engram conversation; messages are
 * stored verbatim and embedded for semantic search.
 */

// --- ChatGPT export shapes ---
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

// --- Claude export shapes ---
interface ClaudeMessage {
  sender?: string; // "human" | "assistant"
  text?: string;
  content?: Array<{ type?: string; text?: string }>;
  created_at?: string | null;
}

export interface ClaudeConversation {
  name?: string | null;
  created_at?: string | null;
  chat_messages?: ClaudeMessage[];
}

export type SourceFormat = "chatgpt" | "claude" | "unknown";

export interface NormalizedConversation {
  title: string;
  created: string | number | null;
  messages: MessageInput[];
}

const STORE_BATCH = 100;

/** Walk a ChatGPT export's node tree (current_node → root) into a chronological list. */
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

/** Flatten a Claude export conversation into a chronological message list. */
export function linearizeClaude(convo: ClaudeConversation): MessageInput[] {
  const out: MessageInput[] = [];
  for (const m of convo.chat_messages ?? []) {
    const role =
      m.sender === "assistant" ? "assistant" : m.sender === "human" ? "user" : null;
    if (!role) continue;
    let text = typeof m.text === "string" ? m.text.trim() : "";
    if (!text && Array.isArray(m.content)) {
      text = m.content
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("\n")
        .trim();
    }
    if (!text) continue;
    out.push({ role, content: text });
  }
  return out;
}

/** Detect the export format and normalize every conversation. */
export function normalizeExport(parsed: unknown): {
  format: SourceFormat;
  conversations: NormalizedConversation[];
} {
  const arr = Array.isArray(parsed)
    ? parsed
    : ((parsed as { conversations?: unknown[] })?.conversations ?? []);
  if (!Array.isArray(arr) || arr.length === 0) {
    return { format: "unknown", conversations: [] };
  }
  const first = arr[0] as Record<string, unknown>;

  if (first && ("mapping" in first || "current_node" in first)) {
    return {
      format: "chatgpt",
      conversations: (arr as ChatConversation[]).map((c) => ({
        title: (c.title || "Untitled").slice(0, 200),
        created: c.create_time ?? null,
        messages: linearize(c),
      })),
    };
  }

  if (first && ("chat_messages" in first || "sender" in first)) {
    return {
      format: "claude",
      conversations: (arr as ClaudeConversation[]).map((c) => ({
        title: (c.name || "Untitled").slice(0, 200),
        created: c.created_at ?? null,
        messages: linearizeClaude(c),
      })),
    };
  }

  return { format: "unknown", conversations: [] };
}

export async function importHistory(
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
    console.error(
      "\nGet the file from ChatGPT (Settings → Data controls → Export data) or",
    );
    console.error("Claude (Settings → Account → Export data). Format is auto-detected.");
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("Not valid JSON. Point at conversations.json from your export.");
    process.exit(1);
  }

  const { format, conversations } = normalizeExport(parsed);
  if (format === "unknown" || conversations.length === 0) {
    console.error(
      "Unrecognized export. Expected a ChatGPT or Claude conversations.json.",
    );
    process.exit(1);
  }

  const source = format === "claude" ? "claude-import" : "chatgpt-import";
  const toImport = conversations.slice(0, limit);
  console.log(
    `${bold(`${format} import`)} ${dim(`(${toImport.length} of ${conversations.length} conversations${dryRun ? ", dry run" : ""})`)}`,
  );

  let imported = 0;
  let messageTotal = 0;
  let skipped = 0;
  let failed = 0;

  for (const [i, convo] of toImport.entries()) {
    if (convo.messages.length === 0) {
      skipped++;
      continue;
    }

    const label = `[${i + 1}/${toImport.length}] ${convo.title} ${dim(`(${convo.messages.length} msgs)`)}`;
    if (dryRun) {
      console.log(`  ${dim("would import")} ${label}`);
      imported++;
      messageTotal += convo.messages.length;
      continue;
    }

    try {
      const tags = [source, ...(extraTag ? [extraTag] : [])];
      const { conversationId } = await engram.createConversation({
        title: convo.title,
        agentId: source,
        tags,
        metadata: { source: `${format}-export`, original_create_time: convo.created },
      });
      for (let b = 0; b < convo.messages.length; b += STORE_BATCH) {
        await engram.store({
          conversationId,
          messages: convo.messages.slice(b, b + STORE_BATCH),
        });
      }
      console.log(`  ${green("✓")} ${label}`);
      imported++;
      messageTotal += convo.messages.length;
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ ${label} — ${msg}`);
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
