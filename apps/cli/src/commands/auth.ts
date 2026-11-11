import { resolveBaseUrl } from "../config.js";
import { loadConfigForUpdate, loadConfigForUse, requireWritableConfig, saveConfigOrExit } from "../config-guard.js";
import { green, red } from "../output.js";
import { Engram } from "@getengram/sdk";
import { autoEnableCapture } from "../daemon/commands.js";
import { engramCommand } from "../daemon/package-runner.js";

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

  // Strict, before the key is sent anywhere (engram#673): read leniently,
  // a file that couldn't be read named no server, so the key went to the
  // default one, and was then saved over the file and what was in it.
  const config = await loadConfigForUpdate();
  // Before the key is sent to be checked (engram#717).
  requireWritableConfig(["So the key wasn't checked or saved."]);

  // Check the key against the server it will be used with, the one every
  // other command and the daemon use (engram#625). This used the SDK's
  // default server whatever was configured: it refused keys for any other
  // server, and sent them to that one.
  try {
    const engram = new Engram({ apiKey: key, baseUrl: resolveBaseUrl(config) });
    await engram.listConversations({ limit: 1 });
  } catch {
    console.error(red("Authentication failed. Check your API key."));
    process.exit(1);
  }

  config.apiKey = key;
  await saveConfigOrExit(config, ["So the key wasn't saved."]);

  console.log(green("✓ Authenticated successfully"));
  console.log(`  Key saved to ~/.engram/config.json`);
  console.log(`  Prefix: ${key.slice(0, 20)}...`);
  await autoEnableCapture({ after: "login" });
}

export async function authLogout(): Promise<void> {
  const config = await loadConfigForUpdate([
    `To sign out anyway: run '${engramCommand("stop")}', then remove the file. The folders you`,
    "excluded from capture go with it.",
  ]);
  // With no key saved there's nothing to remove, so nothing is written: a
  // config.json that can't be written isn't a reason to stop (engram#717).
  if (config.apiKey !== undefined) {
    delete config.apiKey;
    await saveConfigOrExit(
      config,
      ["You're still signed in, and auto-capture keeps using the key saved there."],
      "auth logout",
    );
  }
  console.log(green("✓ Logged out"));
  // The daemon reads config.json every few seconds (engram#594).
  console.log("  Auto-capture stops sending within a few seconds.");
  console.log("  Messages already queued stay on this machine and are sent only with a key");
  console.log("  for the account they were captured under.");
  console.log("  Anything written while signed out is captured for the next account that signs in.");
  if (process.env.ENGRAM_API_KEY) {
    console.log(
      red("  ENGRAM_API_KEY is set in this shell: commands run here, and a daemon started from here,\n") +
        red("  keep using that key. Unset it to sign out completely."),
    );
  }
}

export async function authStatus(): Promise<void> {
  // Strict (engram#673): one that can't be read isn't "not authenticated".
  const config = await loadConfigForUse();
  const key = process.env.ENGRAM_API_KEY ?? config.apiKey;

  if (!key) {
    console.log("Not authenticated");
    console.log(`\nRun: ${engramCommand("auth login <api-key>")}`);
    return;
  }

  const source = process.env.ENGRAM_API_KEY ? "ENGRAM_API_KEY env var" : "~/.engram/config.json";
  console.log(`Authenticated via ${source}`);
  console.log(`  Key prefix: ${key.slice(0, 20)}...`);
}
