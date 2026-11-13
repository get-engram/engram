import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { Conversation, Engram, Message, MessageInput } from "@getengram/sdk";
import { resolveBaseUrl } from "../config.js";
import { configForUse } from "../config-guard.js";
import { engramCommand } from "../daemon/package-runner.js";
import { green, dim, bold, plural } from "../output.js";
import { boundContent } from "../message-bounds.js";
import {
  classifyError,
  isConversationGone,
  isImportMoved,
  isNotFound,
} from "../daemon/status.js";
import {
  ImportDigest,
  markBatch,
  mostToSend,
  patientCaller,
  planFromStored,
  planResume,
  PATIENCE_MS,
  StillRefused,
  type SettledPlan,
} from "../import-resume.js";

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
 *
 * Running it again finishes what an earlier run didn't (engram#751): a
 * conversation cut off partway, by a full memory, a plan limit, a lost
 * connection or Ctrl+C, gets the messages it is missing, as does one that
 * went on after it was imported, and nothing is stored twice. See
 * import-resume.ts.
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

/**
 * Most encoded content one store request carries, in bytes (engram#750):
 * far inside the worker's 8 MB request limit, which 100 long messages of
 * pasted documents could pass.
 */
export const STORE_BATCH_BYTES = 2 * 1024 * 1024;

/**
 * A conversation's messages as store requests (engram#750). Each body is
 * bounded the way Engram bounds it on arrival (file payloads replaced with
 * a note, then clipped), so Engram stores the same text, or in one case
 * less (see message-bounds.ts), and each request carries at most
 * STORE_BATCH messages and STORE_BATCH_BYTES of content as sent. A request
 * always carries at least one message; bounded, one is far inside the
 * limit.
 */
export function storeBatches(messages: readonly MessageInput[]): MessageInput[][] {
  const batches: MessageInput[][] = [];
  let batch: MessageInput[] = [];
  let bytes = 0;
  for (const m of messages) {
    const content = boundContent(m.content);
    const message = content === m.content ? m : { ...m, content };
    const size = Buffer.byteLength(JSON.stringify(content));
    if (batch.length > 0 && (batch.length >= STORE_BATCH || bytes + size > STORE_BATCH_BYTES)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(message);
    bytes += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

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
        `Fallback: ChatGPT Settings → Data controls → Export data, then: ${engramCommand("import conversations.json")}`,
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

/**
 * Human-readable warning for an import that won't fit in remaining memory.
 * `messageCount` is the most the import sends. `exportCount`, when it is
 * more, is how many messages the export has: an earlier import stored part
 * of it, and a re-run doesn't send that again (engram#754).
 */
export function storageWarning(
  messageCount: number,
  check: { remaining: number; limit: number },
  exportCount = messageCount,
): string {
  const n = (x: number) => x.toLocaleString("en-US");
  const sends =
    exportCount > messageCount
      ? `Your export contains ${plural(exportCount, "message")}. An earlier import stored part of it, ` +
        `so this import sends at most ${n(messageCount)} of them, but`
      : `Your export contains ${plural(messageCount, "message")}, but`;
  return (
    `${sends} your engram plan has ` +
    `${n(check.remaining)} of ${n(check.limit)} messages of memory remaining. ` +
    `Importing will stop when memory is full — everything imported stays saved forever. ` +
    `Upgrade for more space: https://getengram.app/pricing`
  );
}


/** Fetch lifetime storage usage; returns null on any failure (never blocks the import). */
async function fetchStorageUsage(): Promise<StorageUsage | null> {
  try {
    // Strict (engram#673): never the default server in place of the one
    // config.json names.
    const read = await configForUse();
    if ("problem" in read) return null;
    const config = read.config;
    const apiKey = process.env.ENGRAM_API_KEY ?? config.apiKey;
    if (!apiKey) return null;
    const baseUrl = resolveBaseUrl(config);
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

/** Conversations listed per request while counting what an import sends: list_conversations' most. */
const LIST_PAGE = 100;

/** Most conversations listed while counting what an import sends. Any past them count in full. */
const LIST_MOST = 10_000;

/**
 * At most how many messages importing `conversations` sends (engram#754).
 * An import sends a conversation an earlier one made only what it is
 * missing, so such a conversation counts only that (mostToSend), from what
 * Engram's list of the conversations imported from this format says of it.
 * One the list doesn't show counts in full, as does one whose fingerprint
 * two conversations have, in the file or in Engram: the import could send
 * it all.
 *
 * The list is read only while it matters: newest first, which finds the
 * conversations of an import that was cut off soonest, and only until
 * what's left fits in `room`. A page that can't be read ends it, and what
 * wasn't found by then counts in full.
 */
async function countToSend(
  engram: Engram,
  agentId: string,
  format: SourceFormat,
  conversations: readonly NormalizedConversation[],
  room: number,
): Promise<number> {
  let toSend = 0;
  // The file's conversations an earlier import could have made, by fingerprint.
  const inFile = new Map<string, readonly MessageInput[]>();
  const twice = new Set<string>();
  for (const c of conversations) {
    toSend += c.messages.length;
    if (!c.sourceId || c.messages.length === 0) continue;
    const fingerprint = `${format}:${c.sourceId}`;
    if (inFile.has(fingerprint)) twice.add(fingerprint);
    inFile.set(fingerprint, c.messages);
  }
  for (const fingerprint of twice) inFile.delete(fingerprint);
  if (inFile.size === 0) return toSend;

  console.log(dim("Checking what Engram already has of this export…"));
  // Each fingerprint found: the conversation it was found on, and what it took off.
  const found = new Map<string, { id: string; less: number }>();
  for (let offset = 0; toSend > room && offset < LIST_MOST; offset += LIST_PAGE) {
    let page: Conversation[];
    try {
      ({ conversations: page } = await engram.listConversations({
        agentId,
        sort: "created_at",
        order: "desc",
        limit: LIST_PAGE,
        offset,
      }));
    } catch {
      break;
    }
    for (const listed of page) {
      const fingerprint = listed.metadata?.import_fingerprint;
      if (typeof fingerprint !== "string") continue;
      const source = inFile.get(fingerprint);
      if (!source) continue;
      const before = found.get(fingerprint);
      if (!before) {
        const less = source.length - mostToSend(listed, source);
        found.set(fingerprint, { id: listed.id, less });
        toSend -= less;
      } else if (before.id !== listed.id) {
        // Two conversations have it: the import may send to either.
        toSend += before.less;
        inFile.delete(fingerprint);
      }
    }
    if (page.length < LIST_PAGE) break;
  }
  return toSend;
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
    `${bold(`${format} import`)} ${dim(`(${toImport.length} of ${plural(conversations.length, "conversation")}${dryRun ? ", dry run" : ""})`)}`,
  );

  // Pre-flight: warn if the export won't fit in remaining lifetime
  // storage (engram#275). A failed usage fetch never blocks — the
  // server enforces the cap anyway.
  if (!dryRun && !("force" in flags)) {
    const inExport = toImport.reduce((n, c) => n + c.messages.length, 0);
    const usage = await fetchStorageUsage();
    let messagesToImport = inExport;
    let check = storagePrecheck(messagesToImport, usage);
    if (!check.fits) {
      // A re-run sends only what Engram doesn't have yet (engram#754):
      // count only that.
      messagesToImport = await countToSend(engram, source, format, toImport, check.remaining);
      check = storagePrecheck(messagesToImport, usage);
    }
    if (!check.fits) {
      console.error(`\n${storageWarning(messagesToImport, check, inExport)}\n`);
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

  const tally: ImportTally = {
    imported: 0,
    messages: 0,
    updated: 0,
    already: 0,
    empty: 0,
    left: [],
    failed: 0,
  };
  let stop: Stop | null = null;
  // Conversations in a row that couldn't be saved because Engram couldn't be
  // reached, or had a problem of its own: any answer from it starts again.
  let unreachable = 0;
  const call = patientCaller((kind) => console.error(dim(`  ${WAITING[kind]}`)));

  for (const [i, convo] of toImport.entries()) {
    if (convo.messages.length === 0) {
      tally.empty++;
      continue;
    }

    const label = `[${i + 1}/${toImport.length}] ${convo.title} ${dim(`(${convo.messages.length} msgs)`)}`;
    if (dryRun) {
      console.log(`  ${dim("would import")} ${label}`);
      tally.imported++;
      tally.messages += convo.messages.length;
      continue;
    }

    // Messages of this conversation saved by this run.
    let saved = 0;
    const stored = (n: number) => {
      saved += n;
      tally.messages += n;
    };
    try {
      const tags = [source, ...(extraTag ? [extraTag] : [])];
      const created = await call(() =>
        engram.createConversation({
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
        }),
      );
      const { conversationId } = created;
      if (!created.existing) {
        await sendFrom(engram, call, conversationId, convo.messages, 0, stored);
        console.log(`  ${green("✓")} ${label}`);
        tally.imported++;
      } else {
        const plan = await planExisting(engram, call, conversationId, created.messageCount, convo.messages);
        if (plan.kind === "done") {
          console.log(`  ${dim("↷ already imported")} ${label}`);
          tally.already++;
        } else if (plan.kind === "send") {
          await sendFrom(engram, call, conversationId, convo.messages, plan.from, stored);
          console.log(`  ${green("✓")} ${label} ${dim(`— added the ${plural(saved, "message")} Engram didn't have yet`)}`);
          tally.updated++;
        } else {
          console.log(`  ${dim("↷ left as it is")} ${label} ${dim(`— ${leftReason(plan)}`)}`);
          tally.left.push({ conversationId, title: convo.title });
        }
      }
      unreachable = 0;
    } catch (err) {
      tally.failed++;
      const kind = classifyError(err);
      const partly = saved > 0 ? ` ${dim(`(${plural(saved, "message")} of it saved first)`)}` : "";
      const fail = (why: string) => console.error(`  ✗ ${label} — ${why}${partly}`);

      // Lifetime storage cap (engram#275): the server rejected the append
      // because memory is full. Everything imported so far is saved.
      const storageFull = parseStorageFullError(messageOf(err));
      if (storageFull) {
        fail("memory full");
        console.error(`\n${storageFull.message}`);
        stop = "storage";
        break;
      }
      if (err instanceof StillRefused) {
        const minutes = PATIENCE_MS[err.kind] / 60_000;
        fail(`${err.message} after ${minutes} minutes of waiting`);
        stop = "waited";
        break;
      }
      if (isImportMoved(err)) {
        // Refused whole: nothing from that request was stored (engram#751).
        // Most often a second import of the same file; the same batch sent
        // again after its answer was lost reads the same, so the line
        // doesn't claim which.
        fail("it changed while this import ran: another import may be adding to it");
        unreachable = 0;
        continue;
      }
      if (isConversationGone(err) || isNotFound(err)) {
        fail("it was deleted from Engram while this import ran");
        unreachable = 0;
        continue;
      }
      if (kind === "auth") {
        fail(`Engram refused this API key: ${errorText(err)}`);
        stop = "auth";
        break;
      }
      if (kind === "billing") {
        fail(errorText(err));
        console.error(dim(`\nHit a plan limit: upgrade at ${PRICING_URL} for more.`));
        stop = "billing";
        break;
      }
      fail(errorText(err));
      // Any other answer shows Engram can be reached.
      unreachable = kind === "network" || kind === "server" ? unreachable + 1 : 0;
      if (unreachable >= UNREACHABLE_STOP) {
        console.error(
          dim(`\n${UNREACHABLE_STOP} conversations in a row couldn't be saved: Engram can't be reached, or is having a problem.`),
        );
        stop = "unreachable";
        break;
      }
    }
  }

  const parts = [`${tally.imported} imported`, plural(tally.messages, "message")];
  if (tally.updated) parts.push(`${tally.updated} updated`);
  if (tally.already) parts.push(`${tally.already} already imported`);
  if (tally.empty) parts.push(`${tally.empty} empty skipped`);
  if (tally.left.length) parts.push(`${tally.left.length} left as ${tally.left.length === 1 ? "it is" : "they are"}`);
  if (tally.failed) parts.push(`${tally.failed} failed`);
  console.log(`\n${bold(stop ? "Stopped." : "Done.")} ${parts.join(", ")}.`);
  if (dryRun) console.log(dim("Dry run — nothing was written. Re-run without --dry-run to import."));

  if (tally.left.length) {
    console.log(
      `\n${tally.left.length === 1 ? "One conversation was" : `${tally.left.length} conversations were`} left as ${tally.left.length === 1 ? "it is" : "they are"}: ` +
        "what Engram has doesn't match this file, so nothing was added. To replace Engram's copy with this file's, " +
        "delete it (everything in Engram's copy goes with it), then run the same command again:",
    );
    for (const { conversationId, title } of tally.left) {
      console.log(`  ${title}`);
      console.log(`    ${engramCommand(`conversations delete ${conversationId} --force`)}`);
    }
  }

  if (stop || tally.failed) {
    console.error(`\n${again(stop ?? "failed")}`);
    process.exitCode = 1;
  }
}

/** What a run did, for its summary. */
interface ImportTally {
  /** New conversations, every message saved. */
  imported: number;
  /** Messages saved by this run. */
  messages: number;
  /**
   * Conversations Engram had only the first messages of: an earlier run
   * was cut off, or the conversation went on after it was imported.
   */
  updated: number;
  already: number;
  empty: number;
  /** Conversations Engram's copy of which doesn't match the file's. */
  left: { conversationId: string; title: string }[];
  failed: number;
}

/** Why the import stopped before the end of the file. */
type Stop = "storage" | "billing" | "auth" | "waited" | "unreachable";

const PRICING_URL = "https://getengram.app/pricing";

/** Conversations in a row Engram can't be reached for before the import stops. */
const UNREACHABLE_STOP = 3;

const AGAIN_REST = "run the same command again: it skips what's already imported and sends only what's missing.";

/** What to do once the import stopped, or some conversations failed. */
function again(why: Stop | "failed"): string {
  const when: Record<Stop | "failed", string> = {
    storage: "Once there's room",
    billing: "Once you've upgraded",
    // Made when said: the command depends on how this CLI was run.
    auth: `Once the key works (${engramCommand("login")} makes a new one)`,
    waited: "Later",
    unreachable: "Once Engram can be reached",
    failed: "To retry what failed",
  };
  return `${when[why]}, ${AGAIN_REST}${why === "storage" ? " Everything imported stays saved." : ""}`;
}

/** Said once, the first time the import waits for each. */
const WAITING = {
  rate_limit: "Engram is limiting how fast this account can save: slowing down and trying again…",
  paused: "Engram paused saving for maintenance: waiting, and nothing is lost meanwhile…",
} as const;

/** An error's message as it came: for Engram's refusals, its JSON answer. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? "");
}

/**
 * What to say of an error, never blank: the reason Engram gave, where its
 * answer is a JSON body with one (`{"error": "<code>", "message": "..."}`),
 * else the message, else the HTTP status.
 */
function errorText(err: unknown): string {
  const text = messageOf(err).trim();
  if (text.startsWith("{")) {
    try {
      const said = (JSON.parse(text) as { message?: unknown } | null)?.message;
      if (typeof said === "string" && said.trim()) return said.trim();
    } catch {
      // Not JSON after all: said as it is.
    }
  }
  if (text) return text;
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? `Engram answered HTTP ${status}` : "no reason given";
}

/** Why a conversation was left as it is, for its line. */
function leftReason(plan: Extract<SettledPlan, { kind: "changed" | "kept" }>): string {
  if (plan.kind === "changed") return "this file's copy of it differs from the one imported before";
  if (plan.stored === 0) return "Engram's copy is empty, but was changed after the import made it";
  return `Engram has ${plural(plan.stored, "message")} of it that can't be matched to this file's first ones`;
}

type Patient = ReturnType<typeof patientCaller>;

/** Messages read per request when checking what an earlier import stored: get_conversation's most. */
const READ_PAGE = 500;

/**
 * What to do with a conversation an earlier import made, from what Engram
 * says of it (engram#751): finish it, leave it, or nothing (done).
 */
async function planExisting(
  engram: Engram,
  call: Patient,
  conversationId: string,
  messageCount: number | undefined,
  source: readonly MessageInput[],
): Promise<SettledPlan> {
  // Engram has at least as many of its messages as the file: nothing to
  // send, and no need to ask for more.
  if (typeof messageCount === "number" && messageCount >= source.length) return { kind: "done" };
  const { conversation } = await call(() =>
    engram.getConversation({ conversationId, messageLimit: 1, messageOffset: 0 }),
  );
  const plan = planResume(conversation, source);
  if (plan.kind !== "check") return plan;
  // Imported before there was a cursor: read every message Engram has of it.
  const stored: Message[] = [];
  let latest = conversation;
  for (;;) {
    const page = await call(() =>
      engram.getConversation({ conversationId, messageLimit: READ_PAGE, messageOffset: stored.length }),
    );
    latest = page.conversation;
    stored.push(...page.messages);
    if (page.messages.length < READ_PAGE || stored.length >= source.length) break;
  }
  return planFromStored(stored, latest, source);
}

/**
 * Store the file's messages from `from` on (engram#751). The last message
 * of each batch carries the import cursor: how many of the file's messages
 * Engram has once that batch is stored, and the digest of them. Engram
 * records it in the same write as the messages, and stores a batch only
 * where the import is, so no message is stored twice. `stored` hears of
 * each batch once Engram has it.
 */
async function sendFrom(
  engram: Engram,
  call: Patient,
  conversationId: string,
  source: readonly MessageInput[],
  from: number,
  stored: (count: number) => void,
): Promise<void> {
  const digest = new ImportDigest();
  for (const m of source.slice(0, from)) digest.add(m);
  let next = from;
  for (const batch of storeBatches(source.slice(from))) {
    // The digest covers the file's messages as they are, not as sent:
    // bounding them is the CLI's business, and may change between versions.
    for (const m of source.slice(next, next + batch.length)) digest.add(m);
    next += batch.length;
    const messages = markBatch(batch, { v: 1, next, digest: digest.hex() });
    await call(() => engram.store({ conversationId, messages }));
    stored(batch.length);
  }
}
