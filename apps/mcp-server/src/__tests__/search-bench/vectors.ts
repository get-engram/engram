import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chunkMessages, chunkId, type Message } from "@getengram/shared";
import { CONVERSATIONS, QUERIES, QUERY_INSTRUCTION } from "./corpus.js";

/**
 * Recorded embeddings for the benchmark corpus (engram#758).
 *
 * The vectors come from the production model, recorded once by
 * scripts/record-search-bench.ts, so the benchmark ranks with the real
 * embedding space and never calls the network. Each is stored as 768 signed
 * bytes (the vector scaled so its largest component is 127), base64. Cosine
 * similarity ignores the scale, and the rounding moves it by about 0.001.
 */

export const EMBEDDINGS_FILE = join(dirname(fileURLToPath(import.meta.url)), "embeddings.json");

export interface EmbeddingsFile {
  model: string;
  dimensions: number;
  vectors: Record<string, string>;
}

export function textKey(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function encodeVector(values: number[]): string {
  const max = values.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
  const bytes = Int8Array.from(values, (v) => Math.round((v / max) * 127));
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

export function decodeVector(encoded: string): number[] {
  const buf = Buffer.from(encoded, "base64");
  return Array.from(new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength));
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export function readEmbeddingsFile(): EmbeddingsFile | null {
  if (!existsSync(EMBEDDINGS_FILE)) return null;
  return JSON.parse(readFileSync(EMBEDDINGS_FILE, "utf8")) as EmbeddingsFile;
}

export interface CorpusChunk {
  id: string;
  conversationId: string;
  text: string;
  startSequence: number;
  endSequence: number;
}

/** The corpus cut into chunks by the production chunker. */
export function corpusChunks(): CorpusChunk[] {
  const out: CorpusChunk[] = [];
  for (const conv of CONVERSATIONS) {
    const messages = conv.messages.map(
      ([role, content], i) =>
        ({
          id: `msg_${conv.id}_${i + 1}`,
          conversation_id: conv.id,
          role,
          content,
          sequence: i + 1,
        }) as unknown as Message,
    );
    for (const c of chunkMessages(messages, { onWarn: () => {} })) {
      out.push({
        id: chunkId(conv.id, c.startSequence, c.endSequence, c.index),
        conversationId: conv.id,
        text: c.text,
        startSequence: c.startSequence,
        endSequence: c.endSequence,
      });
    }
  }
  return out;
}

/** Every text the benchmark embeds: chunks, queries, and queries with the instruction. */
export function textsToEmbed(): string[] {
  const texts = new Set<string>();
  for (const c of corpusChunks()) texts.add(c.text);
  for (const q of QUERIES) {
    texts.add(q.query);
    texts.add(QUERY_INSTRUCTION + q.query);
  }
  return [...texts];
}
