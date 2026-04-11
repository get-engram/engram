import { EMBEDDING_MODEL } from "@getengram/shared";
import type { Env } from "../types.js";

export async function generateEmbeddings(
  ai: Env["AI"],
  texts: string[]
): Promise<number[][]> {
  const response = await ai.run(EMBEDDING_MODEL as keyof AiModels, {
    text: texts,
  }) as { data: number[][] };

  return response.data;
}

export async function generateEmbedding(
  ai: Env["AI"],
  text: string
): Promise<number[]> {
  const results = await generateEmbeddings(ai, [text]);
  return results[0];
}
