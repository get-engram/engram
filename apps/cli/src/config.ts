import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".engram");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

interface Config {
  apiKey?: string;
  baseUrl?: string;
  /** "off" = the user explicitly stopped capture; the CLI must not
   *  resurrect the daemon until they run start/install again. */
  autocapture?: "on" | "off";
  /** Absolute paths whose sessions are never captured (engram#462).
   *  Managed via `engram exclude add|remove|list`; the daemon hot-reloads
   *  this list, no restart needed. */
  excludePaths?: string[];
}

export async function loadConfig(): Promise<Config> {
  try {
    const raw = await readFile(CONFIG_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Like loadConfig, but a config.json that exists and can't be read or
 * parsed THROWS instead of reading as empty. The daemon re-reads the key
 * every couple of seconds and treats "no key" as a logout (engram#594), so
 * a file caught half-written, or one damaged by hand, must not look like
 * one: that would stop capture for nothing. Only a missing file means
 * there is no config.
 */
export async function loadConfigStrict(): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(CONFIG_FILE, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return {};
    throw err;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("config.json is not a JSON object");
  }
  return parsed as Config;
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
