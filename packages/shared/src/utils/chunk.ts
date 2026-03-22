import type { Message } from "../types/index.js";

const WINDOW_SIZE = 5;
const STRIDE = 3;

export interface ChunkResult {
  text: string;
  startSequence: number;
  endSequence: number;
}

export function chunkMessages(messages: Message[]): ChunkResult[] {
  if (messages.length === 0) return [];

  const sorted = [...messages].sort((a, b) => a.sequence - b.sequence);
  const chunks: ChunkResult[] = [];

  for (let i = 0; i < sorted.length; i += STRIDE) {
    const window = sorted.slice(i, i + WINDOW_SIZE);
    if (window.length === 0) break;

    const text = window
      .map((m) => `[${m.role}]: ${m.content}`)
      .join("\n");

    chunks.push({
      text,
      startSequence: window[0].sequence,
      endSequence: window[window.length - 1].sequence,
    });

    // If window didn't fill, we've reached the end
    if (window.length < WINDOW_SIZE) break;
  }

  return chunks;
}
