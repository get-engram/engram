import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Engram, type MessageInput } from "@getengram/sdk";
import { loadConfig, getBaseUrl } from "../config.js";
import { green, dim, bold } from "../output.js";

import { parseStorageFullError } from "../storage-error.js";
// Re-exported for backwards compatibility: this parser moved to a shared module
// so the sync daemon can use it without importing this command.
export { parseStorageFullError, type StorageFullError } from "../storage-error.js";

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
  id?: string | null;
  conversation_id?: string | null;
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
  uuid?: string | null;
  name?: string | null;
  created_at?: string | null;
  chat_messages?: ClaudeMessage[];
}

export type SourceFormat = "chatgpt" | "claude" | "unknown";

export interface NormalizedConversation {
  title: string;
  created: string | number | null;
  messages: MessageInput[];
  /**
   * Stable id from the source export (ChatGPT conversation id / Claude
   * uuid). Drives idempotent re-imports (engram#254); null when the
   * export doesn't carry one.
   */
  sourceId: string | null;
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
// --- ChatGPT share-link import (engram: conversation-full rescue) ---
// When ChatGPT declares a conversation full it also stops the connector
// from saving — the share link becomes the only way the content gets out.
// `engram import <share-url>` fetches the public share page, digs the
// embedded conversation JSON out of it, and funnels it through the same
// pipeline as an export-file import.

export const SHARE_URL_RE =
  /^https?:\/\/(chatgpt\.com|chat\.openai\.com)\/share\/([A-Za-z0-9-]+)/;

/** Balanced-brace scan starting at an opening brace, string/escape aware. */
function scanBalanced(s: string, start: number): string | null {
  if (s[start] !== "{") return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/** Deep-search parsed JSON for the first object shaped like a ChatGPT
 *  conversation: a `mapping` whose nodes carry `message` entries. */
function findConversation(x: unknown, depth: number): ChatConversation | null {
  if (!x || typeof x !== "object" || depth > 14) return null;
  const o = x as Record<string, unknown>;
  if (o.mapping && typeof o.mapping === "object" && !Array.isArray(o.mapping)) {
    const nodes = Object.values(o.mapping as Record<string, unknown>);
    if (
      nodes.length > 0 &&
      nodes.some((n) => n !== null && typeof n === "object" && "message" in (n as object))
    ) {
      return o as ChatConversation;
    }
  }
  for (const v of Array.isArray(x) ? x : Object.values(o)) {
    const found = findConversation(v, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Pull the embedded conversation out of a share page's HTML. Tries every
 *  JSON <script> blob, then `window.__remixContext`-style inline
 *  assignments. Returns null when nothing parses — the caller points the
 *  user at the export-file fallback. Exported for tests. */
export function extractSharedConversation(html: string): ChatConversation | null {
  const candidates: unknown[] = [];
  for (const m of html.matchAll(
    /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g,
  )) {
    try {
      candidates.push(JSON.parse(m[1]));
    } catch {
      // not JSON — skip
    }
  }
  for (const marker of ["__remixContext", "__NEXT_DATA__", "streamController.enqueue"]) {
    let idx = html.indexOf(marker);
    while (idx !== -1) {
      const braceAt = html.indexOf("{", idx);
      if (braceAt === -1) break;
      const blob = scanBalanced(html, braceAt);
      if (blob) {
        try {
          candidates.push(JSON.parse(blob));
        } catch {
          // partial/escaped blob — skip
        }
      }
      idx = html.indexOf(marker, idx + marker.length);
    }
  }
  for (const c of candidates) {
    const found = findConversation(c, 0);
    if (found) return found;
  }
  return null;
}

export async function fetchSharedConversation(url: string): Promise<ChatConversation> {
  const m = url.match(SHARE_URL_RE);
  if (!m) throw new Error("Not a ChatGPT share link");
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) engram-cli",
      Accept: "text/html",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(
      `Share page returned ${res.status}` +
        (res.status === 404
          ? " — the link may have been deleted, made private, or never published"
          : ""),
    );
  }
  const convo = extractSharedConversation(await res.text());
  if (!convo) {
    throw new Error(
      "Couldn't find the conversation in the share page — ChatGPT may have changed its page format.\n" +
        "Fallback: ChatGPT Settings → Data controls → Export data, then: engram import conversations.json",
    );
  }
  // Idempotent re-imports: if the conversation JSON carries no id, the
  // share-link id stands in as the fingerprint.
  if (!convo.id && !convo.conversation_id) convo.conversation_id = `share-${m[2]}`;
  return convo;
}

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
        sourceId: c.id ?? c.conversation_id ?? null,
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
        sourceId: c.uuid ?? null,
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
    console.error("Usage: engram import <conversations.json | chatgpt-share-link> [options]");
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
    console.error(
      "\nOr rescue a single conversation via its share link (ChatGPT → Share → Copy link):",
    );
    console.error("  engram import https://chatgpt.com/share/<id>");
    process.exit(1);
  }

  const dryRun = "dry-run" in flags || "dryRun" in flags;
  const limit = flags.limit ? parseInt(flags.limit, 10) : Infinity;
  const extraTag = flags.tag;

  let parsed: unknown;
  if (SHARE_URL_RE.test(file)) {
    console.log(dim("Fetching shared conversation..."));
    try {
      parsed = [await fetchSharedConversation(file)];
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  } else {
    let raw: string;
    try {
      raw = await readFile(file, "utf-8");
    } catch {
      console.error(`Could not read ${file}`);
      process.exit(1);
    }
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error("Not valid JSON. Point at conversations.json from your export.");
      process.exit(1);
    }
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
      const { conversationId, existing } = await engram.createConversation({
        title: convo.title,
        agentId: source,
        tags,
        metadata: {
          source: `${format}-export`,
          original_create_time: convo.created,
          // Stable fingerprint → re-imports reuse the same conversation
          // instead of duplicating it (engram#254).
          ...(convo.sourceId ? { import_fingerprint: `${format}:${convo.sourceId}` } : {}),
        },
      });
      if (existing) {
        console.log(`  ${dim("↷ already imported")} ${label}`);
        skipped++;
        continue;
      }
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
