import { dirname } from "node:path";
import { generateVaultKey, type Engram } from "@getengram/sdk";
import { bold, dim, plural, red } from "../output.js";
import { confirmedDaemonInPidFile, probeDaemon } from "../daemon/instance.js";
import { ensurePrivateDirSync, writePrivateFileSync } from "../private-files.js";
import {
  envVaultKeyState,
  isVaultKey,
  readVaultKeyFile,
  sameVaultKey,
  VAULT_KEY_FILE,
  vaultKeyFileState,
  VaultKeyUnreadable,
  vaultKeyFix,
} from "../vault-key.js";

/**
 * The key in ~/.engram/vault-key, about to be replaced, or undefined when
 * there is none. One that can't be read can't be backed up, so it isn't
 * replaced, --force or not: that could orphan every secret encrypted with
 * it (engram#677). The command stops there. An empty file has nothing in it
 * to lose.
 */
async function readKeyToReplace(): Promise<string | undefined> {
  try {
    return await readVaultKeyFile();
  } catch (err: unknown) {
    if (!(err instanceof VaultKeyUnreadable)) throw err;
    if (err.kind === "empty") return undefined;
    console.error(red(`Error: ${err.message}, so it can't be backed up, and isn't replaced.`));
    console.error(dim(`  ${vaultKeyFix(err)}`));
    console.error(dim("  Then run this again. Or move it aside yourself:"));
    console.error(dim("    mv ~/.engram/vault-key ~/.engram/vault-key.old"));
    process.exit(1);
  }
}

/** Back up the key about to be replaced, so a --force by mistake can be undone. */
function backUpKey(existing: string): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${VAULT_KEY_FILE}.bak-${stamp}`;
  writePrivateFileSync(backup, existing + "\n");
  console.log(dim(`Previous key backed up to ${backup}`));
}

export async function vaultKeygen(
  _args: string[],
  flags: Record<string, string>
): Promise<void> {
  const key = await generateVaultKey();

  if (flags.save !== undefined) {
    // ~/.engram may not exist yet on a fresh machine; without this, the
    // write ENOENT-crashes on the very first `vault keygen --save`. It is
    // the user's alone (engram#627).
    ensurePrivateDirSync(dirname(VAULT_KEY_FILE));

    // Overwriting the key file is irreversible destruction: every secret
    // encrypted under the old key becomes permanently undecryptable. Refuse
    // unless the user explicitly passes --force, and back the old key up first
    // so an accidental --force is still recoverable.
    const existing = await readKeyToReplace();
    if (existing && flags.force === undefined) {
      console.error(bold(`A vault key already exists at ${VAULT_KEY_FILE}.`));
      console.error(
        "Overwriting it will PERMANENTLY orphan every secret encrypted with the current key —"
      );
      console.error("there is no recovery. Re-run with --force to replace it (the old key is backed up first).");
      process.exit(1);
    }
    if (existing) backUpKey(existing);

    // 0600, and in one step: a write cut short leaves the old key whole.
    // An overwrite in place also kept an old file's mode.
    writePrivateFileSync(VAULT_KEY_FILE, key + "\n");
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
  // A daemon started at login may not get a shell's variables: it reads
  // the file (engram#690).
  if (flags.save === undefined) {
    console.log(dim("  Then 'engram vault save-key' saves it for the daemon started at login."));
  }
}

/**
 * Save the key in ENGRAM_VAULT_KEY to ~/.engram/vault-key, readable only by
 * the user (engram#690). A daemon started at login may not get a shell's
 * variables: it reads the file, and without the key there, captures without
 * the vault's secrets removed. Unlike `keygen --save`, no new key is made,
 * and another key in the file is replaced only with --force, backed up
 * first. The key is never printed, nor any of it.
 */
export async function vaultSaveKey(flags: Record<string, string>): Promise<void> {
  const envKey = process.env.ENGRAM_VAULT_KEY;
  if (!envKey) {
    console.error(red("Error: ENGRAM_VAULT_KEY isn't set, so there is no key to save."));
    console.error(dim("  To make a new vault key and save it instead: engram vault keygen --save"));
    process.exit(1);
  }
  const key = envKey.trim();
  if (!isVaultKey(key)) {
    console.error(red("Error: ENGRAM_VAULT_KEY doesn't hold a vault key, so it isn't saved."));
    console.error(dim("  A vault key is 32 bytes, base64-encoded, as 'engram vault keygen' makes one."));
    process.exit(1);
  }

  ensurePrivateDirSync(dirname(VAULT_KEY_FILE));
  const existing = await readKeyToReplace();
  if (existing === key) {
    console.log(`${bold("Already saved:")} ${VAULT_KEY_FILE} holds the key in ENGRAM_VAULT_KEY.`);
    return;
  }
  // The same key, written another way (padding): nothing to lose, and it is
  // written as ENGRAM_VAULT_KEY has it. The daemon scrubs the key's own
  // text from what it captures, and that text is the one a shell shows.
  const another = existing !== undefined && !sameVaultKey(existing, key);
  if (another && flags.force === undefined) {
    console.error(bold("~/.engram/vault-key holds a different vault key."));
    console.error("Secrets encrypted with it can only be read with it. To replace it all the same,");
    console.error("run this again with --force: the key in the file is backed up first.");
    process.exit(1);
  }
  if (another) backUpKey(existing);

  // 0600, and in one step: a write cut short leaves the old key whole.
  writePrivateFileSync(VAULT_KEY_FILE, key + "\n");
  console.log(`${bold("Vault key saved to:")} ${VAULT_KEY_FILE}`);
  console.log(dim("Permissions set to owner-only (600). The daemon started at login reads it there."));
  // The daemon reads its key when it starts.
  if (await daemonRunning()) {
    console.log(dim("The daemon running now read its key when it started. If that was without this one,"));
    console.log(dim("as at login, run 'engram stop', then 'engram start'."));
  }
}

/**
 * A daemon is running: it answers, or is busy, on its socket; or, one from
 * before engram#612, which has none, its PID file names it, confirmed.
 */
async function daemonRunning(): Promise<boolean> {
  const probe = await probeDaemon({ timeoutMs: 1_000 });
  if (probe.state === "answered") return !probe.info.stopping;
  if (probe.state === "silent") return true;
  return confirmedDaemonInPidFile() !== null;
}

export async function vaultStatus(): Promise<void> {
  // The key every command uses: ENGRAM_VAULT_KEY wins over the file.
  const envKey = process.env.ENGRAM_VAULT_KEY;
  if (envKey) {
    const bytes = Buffer.from(envKey.trim(), "base64");
    console.log(
      bytes.length === 32
        ? `${bold("Vault:")} configured (key in ENGRAM_VAULT_KEY)`
        : `${bold("Vault:")} invalid key in ENGRAM_VAULT_KEY (expected 32 bytes, got ${bytes.length})`
    );
    // The daemon reads the file when started without it, as at login.
    const file = await vaultKeyFileState();
    if (file instanceof VaultKeyUnreadable) {
      console.log(red(`  ~/.engram/vault-key, which the daemon reads, ${file.problem}. See 'engram status'.`));
      return;
    }
    // Not saved there (engram#690). Not said for a key that isn't one.
    const saved = await envVaultKeyState();
    if (saved === "none") {
      console.log(red("  ~/.engram/vault-key isn't there: a daemon started at login may not have this key."));
      console.log(dim("  To save it there, readable only by you: engram vault save-key"));
    } else if (saved === "different") {
      console.log(red("  ~/.engram/vault-key holds a different key: a daemon started at login may use that one."));
      console.log(dim("  If this one is right: engram vault save-key --force (the file's key is backed up first)"));
    }
    return;
  }

  let key: string | undefined;
  try {
    key = await readVaultKeyFile();
  } catch (err: unknown) {
    if (!(err instanceof VaultKeyUnreadable)) throw err;
    // Not "not configured" (engram#677): there is a key, and nothing that
    // needs it goes ahead without it.
    console.log(`${bold("Vault:")} ${red(`the key can't be read: ${err.message}`)}`);
    console.log(dim(`  ${vaultKeyFix(err)}`));
    console.log(dim("  Until then, commands that need the key won't run, and the daemon holds"));
    console.log(dim("  messages on this machine rather than send them unscrubbed."));
    return;
  }
  if (key === undefined) {
    console.log(`${bold("Vault:")} not configured`);
    console.log(dim("Run 'engram vault keygen --save' to generate a key."));
    return;
  }
  const bytes = Buffer.from(key, "base64");
  if (bytes.length === 32) {
    console.log(
      `${bold("Vault:")} configured (key at ${VAULT_KEY_FILE})`
    );
    console.log(dim(`Key prefix: ${key.slice(0, 8)}...`));
  } else {
    console.log(
      `${bold("Vault:")} invalid key (expected 32 bytes, got ${bytes.length})`
    );
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

  let value: string | null;
  try {
    value = await client.vault.get(name);
  } catch {
    // The central failure mode of a zero-knowledge vault: retrieving on a
    // different machine, or after the key was regenerated/overwritten. Web
    // Crypto throws an opaque "operation-specific reason" here — translate it.
    console.error(`Failed to decrypt "${name}": wrong vault key or corrupted data.`);
    console.error(
      `The value must be decrypted with the SAME key it was encrypted with. Check ENGRAM_VAULT_KEY or ${VAULT_KEY_FILE}.`
    );
    process.exit(1);
    return;
  }
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
  console.log(dim(plural(secrets.length, "secret")));
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
