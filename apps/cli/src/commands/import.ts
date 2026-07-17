import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Engram, type MessageInput } from "@getengram/sdk";
import { loadConfig, getBaseUrl } from "../config.js";
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
 *   engram import conversations.json --force        # skip the storage pre-check
 *
 * Each source conversation becomes an Engram conversation; messages are
 * stored verbatim and embedded for semantic search. Before importing, the
 * remaining lifetime storage is checked (engram#275) and a warning is
 * shown if the export won't fit; if memory fills up mid-import, the
 * import stops gracefully — everything already imported stays saved.
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

// --- Lifetime storage pre-check (engram#275) ---

export interface StorageUsage {
  used: number;
  limit: number; // -1 = unlimited
}

export type StoragePrecheck =
  | { fits: true }
  | { fits: false; remaining: number; used: number; limit: number };

/**
 * Decide whether importing `messageCount` messages fits in the remaining
 * lifetime storage. A `null` usage (the fetch failed) never blocks — the
 * server enforces the cap anyway.
 */
export function storagePrecheck(
  messageCount: number,
  storage: StorageUsage | null,
): StoragePrecheck {
  if (!storage || storage.limit === -1) return { fits: true };
  const remaining = Math.max(0, storage.limit - storage.used);
  if (messageCount <= remaining) return { fits: true };
  return { fits: false, remaining, used: storage.used, limit: storage.limit };
}

/** Human-readable warning for an export that won't fit in remaining memory. */
export function storageWarning(
  messageCount: number,
  check: { remaining: number; limit: number },
): string {
  const n = (x: number) => x.toLocaleString("en-US");
  return (
    `Your export contains ${n(messageCount)} messages, but your engram plan has ` +
    `${n(check.remaining)} of ${n(check.limit)} messages of memory remaining. ` +
    `Importing will stop when memory is full — everything imported stays saved forever. ` +
    `Upgrade for more space: https://getengram.app/pricing`
  );
}

/**
 * Parse an SDK error message as the server's `storage_full` payload. The
 * MCP tool returns it as an isError JSON body, which the SDK surfaces
 * verbatim as the Error message. Returns null for anything else.
 */
export function parseStorageFullError(raw: string): {
  message: string;
  used?: number;
  limit?: number;
  upgrade_url?: string;
} | null {
  try {
    const parsed = JSON.parse(raw) as {
      error?: string;
      message?: string;
      used?: number;
      limit?: number;
      upgrade_url?: string;
    };
    if (parsed?.error !== "storage_full") return null;
    return {
      message: parsed.message || "Engram's memory is full.",
      used: parsed.used,
      limit: parsed.limit,
      upgrade_url: parsed.upgrade_url,
    };
  } catch {
    return null;
  }
}

/** Fetch lifetime storage usage; returns null on any failure (never blocks the import). */
async function fetchStorageUsage(): Promise<StorageUsage | null> {
  try {
    const config = await loadConfig();
    const apiKey = process.env.ENGRAM_API_KEY ?? config.apiKey;
    if (!apiKey) return null;
    const baseUrl = process.env.ENGRAM_BASE_URL ?? config.baseUrl ?? getBaseUrl();
    const res = await fetch(`${baseUrl}/api/usage`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      storage?: { used?: number; limit?: number };
    };
    if (
      typeof data.storage?.used !== "number" ||
      typeof data.storage?.limit !== "number"
    ) {
      return null;
    }
    return { used: data.storage.used, limit: data.storage.limit };
  } catch {
    return null;
  }
}

/** y/N confirmation prompt. EOF (Ctrl+D) counts as "no". */
function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    let answered = false;
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
    rl.on("close", () => {
      if (!answered) resolve(false);
    });
  });
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
      "  --force          Import even if the export won't fit in remaining memory",
    );
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

  // Pre-flight: warn if the export won't fit in remaining lifetime
  // storage (engram#275). A failed usage fetch never blocks — the
  // server enforces the cap anyway.
  if (!dryRun && !("force" in flags)) {
    const messagesToImport = toImport.reduce((n, c) => n + c.messages.length, 0);
    const check = storagePrecheck(messagesToImport, await fetchStorageUsage());
    if (!check.fits) {
      console.error(`\n${storageWarning(messagesToImport, check)}\n`);
      if (process.stdin.isTTY) {
        const proceed = await confirm("Continue anyway? [y/N] ");
        if (!proceed) {
          console.error("Import cancelled. Nothing was written.");
          process.exit(1);
        }
      } else {
        console.error(
          "Re-run with --force to import anyway (it will stop when memory is full).",
        );
        process.exit(1);
      }
    }
  }

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
      const msg = err instanceof Error ? err.message : String(err);

      // Lifetime storage cap (engram#275): the server rejected the append
      // because memory is full. Everything imported so far is saved.
      const storageFull = parseStorageFullError(msg);
      if (storageFull) {
        console.error(`  ✗ ${label} — memory full`);
        console.error(`\n${storageFull.message}`);
        console.error(
          dim(
            `\nStopped with ${imported} conversations (${messageTotal} messages) imported — everything imported stays saved forever.`,
          ),
        );
        process.exit(1);
      }

      failed++;
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
