import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateVaultKey, type Engram } from "@getengram/sdk";
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

/**
 * Store a named secret. Follows GitHub Secrets pattern:
 * - Reads value from stdin, --value flag, or positional arg (in that order)
 * - Value is encrypted client-side before transmission
 * - Shell history is avoided when using stdin
 *
 * Usage:
 *   echo "postgres://..." | engram vault set DATABASE_URL
 *   engram vault set DATABASE_URL --value "postgres://..."
 *   engram vault set DATABASE_URL "postgres://..."
 */
export async function vaultSet(
  client: Engram,
  args: string[],
  flags: Record<string, string>
): Promise<void> {
  const name = args[0];
  if (!name) {
    console.error("Usage: engram vault set <NAME> [value]");
    console.error("       echo 'value' | engram vault set <NAME>");
    process.exit(1);
  }

  let value: string | undefined;

  // 1. Check --value flag
  if (flags.value !== undefined) {
    value = flags.value;
  }
  // 2. Check positional arg
  else if (args[1]) {
    value = args[1];
  }
  // 3. Check stdin (piped input)
  else if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    value = Buffer.concat(chunks).toString("utf-8").trim();
  }

  if (!value) {
    console.error("No value provided.");
    console.error("Usage: engram vault set <NAME> <value>");
    console.error("       echo 'value' | engram vault set <NAME>");
    process.exit(1);
  }

  await client.vault.set(name, value);
  console.log(`${bold("Secret stored:")} ${name}`);
  console.log(dim("Encrypted client-side. The server never sees the plaintext value."));
}

/**
 * Retrieve a named secret. Decrypts locally with your vault key.
 *
 * Usage:
 *   engram vault get DATABASE_URL
 *   engram vault get DATABASE_URL --json
 */
export async function vaultGet(
  client: Engram,
  args: string[],
  flags: Record<string, string>
): Promise<void> {
  const name = args[0];
  if (!name) {
    console.error("Usage: engram vault get <NAME>");
    process.exit(1);
  }

  const value = await client.vault.get(name);
  if (value === null) {
    console.error(`Secret "${name}" not found.`);
    process.exit(1);
  }

  if (flags.json !== undefined) {
    console.log(JSON.stringify({ name, value }));
  } else {
    // Output raw value (suitable for piping)
    process.stdout.write(value);
    // Add newline only if stdout is a TTY
    if (process.stdout.isTTY) {
      console.log();
    }
  }
}

/**
 * List all named secrets (names and metadata only, never values).
 *
 * Usage:
 *   engram vault list
 *   engram vault list --json
 */
export async function vaultList(
  client: Engram,
  _args: string[],
  flags: Record<string, string>
): Promise<void> {
  const secrets = await client.vault.list();

  if (flags.json !== undefined) {
    console.log(JSON.stringify({ secrets, total: secrets.length }));
    return;
  }

  if (secrets.length === 0) {
    console.log(dim("No secrets stored."));
    console.log(dim("Run 'engram vault set <NAME> <value>' to store one."));
    return;
  }

  // Table header
  const nameWidth = Math.max(4, ...secrets.map((s) => s.name.length)) + 2;
  const typeWidth = Math.max(4, ...secrets.map((s) => s.secretType.length)) + 2;

  console.log(
    bold("NAME".padEnd(nameWidth)) +
    bold("TYPE".padEnd(typeWidth)) +
    bold("UPDATED")
  );

  for (const s of secrets) {
    const updated = s.updatedAt.split("T")[0];
    console.log(
      s.name.padEnd(nameWidth) +
      dim(s.secretType.padEnd(typeWidth)) +
      dim(updated)
    );
  }

  console.log();
  console.log(dim(`${secrets.length} secret(s)`));
}

/**
 * Delete a named secret permanently.
 *
 * Usage:
 *   engram vault delete DATABASE_URL
 */
export async function vaultDelete(
  client: Engram,
  args: string[],
  _flags: Record<string, string>
): Promise<void> {
  const name = args[0];
  if (!name) {
    console.error("Usage: engram vault delete <NAME>");
    process.exit(1);
  }

  const deleted = await client.vault.delete(name);
  if (!deleted) {
    console.error(`Secret "${name}" not found.`);
    process.exit(1);
  }

  console.log(`${bold("Deleted:")} ${name}`);
}
