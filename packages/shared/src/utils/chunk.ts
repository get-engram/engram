import type { Message } from "../types/index.js";

const WINDOW_SIZE = 5;
const STRIDE = 3;

// bge-base-en-v1.5 has a 512-token context window; anything past it is silently
// truncated by the embedding model, so the tail of an oversized chunk would be
// dropped without error. Cap chunks below that with headroom, estimating tokens
// at ~4 chars/token (a conservative average for English + code). (engram#45)
const CHARS_PER_TOKEN = 4;
const MAX_TOKENS = 480;
const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN; // ~1920

export interface ChunkResult {
  text: string;
  startSequence: number;
  endSequence: number;
}

export interface ChunkOptions {
  /** Called when an oversized message/window has to be split. Defaults to console.warn. */
  onWarn?: (message: string) => void;
}

/** Rough token estimate for a string (chars / 4). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

const SUMMARY_MAX_CHARS = 200;

/**
 * Build a short extractive summary of a chunk so agents can triage search
 * results without reading the full chunk_text (engram#61). Strips the
 * "[role]: " line prefixes, collapses whitespace, and returns the first
 * sentence(s) up to ~200 chars. Cheap and synchronous — no model call.
 */
export function summarizeChunk(text: string): string {
  const cleaned = text
    .replace(/^\[[^\]]+\]:\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= SUMMARY_MAX_CHARS) return cleaned;

  // Prefer whole sentences up to the budget (a natural 1-2 sentence summary).
  const sentences = cleaned.match(/[^.!?]+[.!?]+(?:\s|$)/g);
  if (sentences) {
    let out = "";
    for (const s of sentences) {
      if (out.length > 0 && out.length + s.length > SUMMARY_MAX_CHARS) break;
      out += s;
    }
    out = out.trim();
    if (out.length > 0 && out.length <= SUMMARY_MAX_CHARS) return out;
  }
  // Fallback: cut on a word boundary and ellipsize.
  const window = cleaned.slice(0, SUMMARY_MAX_CHARS);
  const space = window.lastIndexOf(" ");
  return (space >= 80 ? window.slice(0, space) : window).trimEnd() + "…";
}

interface Part {
  seq: number;
  text: string;
}

/**
 * Split an oversized window (its formatted per-message parts) into sub-chunks
 * that each fit the embedding budget. A single message larger than the budget
 * is hard-split by characters, keeping its sequence on each piece.
 */
function splitOversized(parts: Part[], warn: (m: string) => void): ChunkResult[] {
  const out: ChunkResult[] = [];
  let buf: Part[] = [];
  let bufChars = 0;

  const flush = () => {
    if (buf.length === 0) return;
    out.push({
      text: buf.map((p) => p.text).join("\n"),
      startSequence: buf[0].seq,
      endSequence: buf[buf.length - 1].seq,
    });
    buf = [];
    bufChars = 0;
  };

  for (const part of parts) {
    if (part.text.length > MAX_CHARS) {
      // One message is too big on its own — flush what we have, then hard-split.
      flush();
      const pieces = Math.ceil(part.text.length / MAX_CHARS);
      warn(
        `chunk: message at sequence ${part.seq} is ~${estimateTokens(part.text)} tokens, over the ${MAX_TOKENS}-token embedding limit; splitting into ${pieces} pieces.`,
      );
      for (let j = 0; j < part.text.length; j += MAX_CHARS) {
        out.push({
          text: part.text.slice(j, j + MAX_CHARS),
          startSequence: part.seq,
          endSequence: part.seq,
        });
      }
      continue;
    }
    const partChars = part.text.length + 1; // + joining newline
    if (bufChars + partChars > MAX_CHARS && buf.length > 0) flush();
    buf.push(part);
    bufChars += partChars;
  }
  flush();
  return out;
}

export function chunkMessages(
  messages: Message[],
  opts: ChunkOptions = {},
): ChunkResult[] {
  if (messages.length === 0) return [];
  const warn = opts.onWarn ?? ((m: string) => console.warn(m));

  const sorted = [...messages].sort((a, b) => a.sequence - b.sequence);
  const chunks: ChunkResult[] = [];

  for (let i = 0; i < sorted.length; i += STRIDE) {
    const window = sorted.slice(i, i + WINDOW_SIZE);
    if (window.length === 0) break;

    const parts: Part[] = window.map((m) => ({
      seq: m.sequence,
      text: `[${m.role}]: ${m.content}`,
    }));
    const text = parts.map((p) => p.text).join("\n");

    if (estimateTokens(text) <= MAX_TOKENS) {
      chunks.push({
        text,
        startSequence: window[0].sequence,
        endSequence: window[window.length - 1].sequence,
      });
    } else {
      // Window overflows the embedding context — split it so nothing is
      // silently truncated at embed time.
      chunks.push(...splitOversized(parts, warn));
    }

    // If window didn't fill, we've reached the end
    if (window.length < WINDOW_SIZE) break;
  }

  return chunks;
}
