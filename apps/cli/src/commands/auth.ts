import { saveConfig, loadConfig } from "../config.js";
import { green, red } from "../output.js";
import { Engram } from "@getengram/sdk";

export async function authLogin(args: string[]): Promise<void> {
  const key = args[0];

  if (!key) {
    console.error("Usage: engram auth login <api-key>");
    console.error("\nExample:");
    console.error("  engram auth login engram_sk_live_iqbm...");
    process.exit(1);
  }

  if (!key.startsWith("engram_sk_live_")) {
    console.error(red("Invalid API key format. Keys start with engram_sk_live_"));
    process.exit(1);
  }

  // Verify the key works
  try {
    const engram = new Engram({ apiKey: key });
    await engram.listConversations({ limit: 1 });
  } catch {
    console.error(red("Authentication failed. Check your API key."));
    process.exit(1);
  }

  const config = await loadConfig();
  config.apiKey = key;
  await saveConfig(config);

  console.log(green("✓ Authenticated successfully"));
  console.log(`  Key saved to ~/.engram/config.json`);
  console.log(`  Prefix: ${key.slice(0, 20)}...`);
}

export async function authLogout(): Promise<void> {
  const config = await loadConfig();
  delete config.apiKey;
  await saveConfig(config);
  console.log(green("✓ Logged out"));
}

export async function authStatus(): Promise<void> {
  const config = await loadConfig();
  const key = process.env.ENGRAM_API_KEY ?? config.apiKey;

  if (!key) {
    console.log("Not authenticated");
    console.log("\nRun: engram auth login <api-key>");
    return;
  }

  const source = process.env.ENGRAM_API_KEY ? "ENGRAM_API_KEY env var" : "~/.engram/config.json";
  console.log(`Authenticated via ${source}`);
  console.log(`  Key prefix: ${key.slice(0, 20)}...`);
}
