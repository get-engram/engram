import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateVaultKey } from "@getengram/sdk";
import { bold, dim } from "../output.js";

const VAULT_KEY_FILE = join(homedir(), ".engram", "vault-key");

export async function vaultKeygen(
  _args: string[],
  flags: Record<string, string>
): Promise<void> {
  const key = await generateVaultKey();

  if (flags.save !== undefined) {
    await writeFile(VAULT_KEY_FILE, key + "\n", { mode: 0o600 });
    console.log(`${bold("Vault key generated and saved to:")} ${VAULT_KEY_FILE}`);
    console.log(dim("Permissions set to owner-only (600)."));
  } else {
    console.log(key);
  }

  console.log();
  console.log(dim("Store this key securely — Engram never sees it."));
  console.log(dim("If you lose it, vaulted secrets cannot be recovered."));
  console.log();
  console.log(`${bold("Usage with SDK:")}`);
  console.log(
    dim(
      `  const engram = new Engram({ apiKey: "...", vault: { encryptionKey: "${key.slice(0, 8)}..." } })`
    )
  );
  console.log();
  console.log(`${bold("Usage with environment variable:")}`);
  console.log(dim("  export ENGRAM_VAULT_KEY=" + key.slice(0, 8) + "..."));
}

export async function vaultStatus(): Promise<void> {
  try {
    const key = await readFile(VAULT_KEY_FILE, "utf-8");
    const trimmed = key.trim();
    const bytes = Buffer.from(trimmed, "base64");
    if (bytes.length === 32) {
      console.log(
        `${bold("Vault:")} configured (key at ${VAULT_KEY_FILE})`
      );
      console.log(dim(`Key prefix: ${trimmed.slice(0, 8)}...`));
    } else {
      console.log(
        `${bold("Vault:")} invalid key (expected 32 bytes, got ${bytes.length})`
      );
    }
  } catch {
    console.log(`${bold("Vault:")} not configured`);
    console.log(dim("Run 'engram vault keygen --save' to generate a key."));
  }
}

export async function loadVaultKey(): Promise<string | undefined> {
  // Environment variable takes precedence
  const envKey = process.env.ENGRAM_VAULT_KEY;
  if (envKey) return envKey;

  // Fall back to file
  try {
    const key = await readFile(VAULT_KEY_FILE, "utf-8");
    return key.trim() || undefined;
  } catch {
    return undefined;
  }
}
