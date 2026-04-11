import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".engram");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

interface Config {
  apiKey?: string;
  baseUrl?: string;
}

export async function loadConfig(): Promise<Config> {
  try {
    const raw = await readFile(CONFIG_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function saveConfig(config: Config): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
}

export function getApiKey(): string {
  const key = process.env.ENGRAM_API_KEY;
  if (!key) {
    console.error(
      "Error: No API key found.\n\n" +
        "Set your API key with:\n" +
        "  engram auth login\n" +
        "  # or\n" +
        "  export ENGRAM_API_KEY=engram_sk_live_...\n",
    );
    process.exit(1);
  }
  return key;
}

export function getBaseUrl(): string {
  return process.env.ENGRAM_BASE_URL ?? "https://mcp.getengram.app";
}
