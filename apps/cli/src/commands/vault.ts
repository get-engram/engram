import { dirname } from "node:path";
import { Engram, generateVaultKey } from "@getengram/sdk";
import { bold, dim, plural, red } from "../output.js";
import { configForUse } from "../config-guard.js";
import { confirmedDaemonInPidFile, probeDaemon, type DaemonInfo } from "../daemon/instance.js";
import { engramCommand } from "../daemon/package-runner.js";
import { decryptFailed } from "../daemon/scrubber.js";
import { readStatus } from "../daemon/status.js";
import { noteVaultChanged } from "../daemon/vault-changed.js";
import { ensurePrivateDirSync, writePrivateFileSync } from "../private-files.js";
import { resolveBaseUrl } from "../server-url.js";
import {
  envVaultKeyState,
  isVaultKey,
  readVaultKeyFile,
  sameVaultKey,
  VAULT_KEY_FILE,
  vaultKeyFileState,
  vaultKeyFingerprint,
  VaultKeyUnreadable,
  vaultKeyFix,
  whyNotVaultKey,
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

/**
 * How many secrets the vault holds, for `keygen --save` with no key saved
 * (engram#694): each was saved with another key, which a new one can't
 * decrypt. Listing them decrypts nothing: the new key is the client's only
 * because the SDK lists with one. "no account": nothing to check, signed
 * out. "unknown": config.json can't be read, or the vault didn't answer.
 */
async function secretsInVault(key: string): Promise<number | "no account" | "unknown"> {
  const read = await configForUse();
  if ("problem" in read) return "unknown";
  const apiKey = process.env.ENGRAM_API_KEY ?? read.config.apiKey;
  if (!apiKey) return "no account";
  try {
    const client = new Engram({
      apiKey,
      baseUrl: resolveBaseUrl(read.config),
      vault: { encryptionKey: key },
      timeout: 10_000,
    });
    return (await client.vault.list()).length;
  } catch {
    return "unknown";
  }
}

/**
 * A new key, with none saved, over secrets the vault holds already
 * (engram#694): none of them decrypt with it, and the daemon holds what it
 * captures until they do, or are gone. Unless --force, the key isn't saved,
 * and the command says what to do instead. A vault that can't be checked
 * doesn't stop it: that is said, and the key is saved.
 */
async function refuseOverVaultSecrets(key: string): Promise<void> {
  const found = await secretsInVault(key);
  if (found === "no account" || found === 0) return;
  if (found === "unknown") {
    console.log(dim("Couldn't check your vault for secrets saved with another key. Any there"));
    console.log(dim(`don't decrypt with this one: '${engramCommand("vault list --check")}' shows which.`));
    return;
  }
  const one = found === 1;
  console.error(bold(`Your vault holds ${plural(found, "secret")}, saved with another vault key.`));
  console.error(`A new key can't decrypt ${one ? "it" : "them"}, so the daemon would hold what it captures`);
  console.error(`rather than send it with ${one ? "that secret" : "those secrets"} in it. The key wasn't saved.`);
  const env = await envVaultKeyState();
  if (env === "none") {
    console.error(dim(`  ENGRAM_VAULT_KEY holds a key. If it's that one, save it: ${engramCommand("vault save-key")}`));
  } else {
    console.error(dim("  If you have that key, put it in ~/.engram/vault-key."));
  }
  console.error(dim(`  To make a new key all the same: ${engramCommand("vault keygen --save --force")}. Then save`));
  console.error(dim(`  ${one ? "the secret" : "each secret"} again with it (${engramCommand("vault set <NAME>")}), or delete ${one ? "it if you no" : "each you no"}`));
  console.error(dim(`  longer use${one ? " it" : ""} (${engramCommand("vault delete <NAME>")}).`));
  process.exit(1);
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
    else if (flags.force === undefined) await refuseOverVaultSecrets(key);

    // 0600, and in one step: a write cut short leaves the old key whole.
    // An overwrite in place also kept an old file's mode.
    writePrivateFileSync(VAULT_KEY_FILE, key + "\n");
    console.log(`${bold("Vault key generated and saved to:")} ${VAULT_KEY_FILE}`);
    console.log(dim("Permissions set to owner-only (600)."));
    console.log(fingerprintLine(key));
    await printDaemonKeyHint(true);
  } else {
    console.log(key);
    console.log(fingerprintLine(key));
  }

  console.log();
  console.log(dim("Store this key securely — Engram never sees it."));
  console.log(dim("If you lose it, vaulted secrets cannot be recovered."));
  console.log();
  // None of the key here (engram#699): saved, it isn't shown at all.
  console.log(`${bold("Usage with SDK:")}`);
  console.log(
    dim(`  const engram = new Engram({ apiKey: "...", vault: { encryptionKey: process.env.ENGRAM_VAULT_KEY! } })`)
  );
  console.log();
  console.log(`${bold("Usage with environment variable:")}`);
  console.log(
    dim(
      flags.save !== undefined
        ? `  export ENGRAM_VAULT_KEY="$(cat ~/.engram/vault-key)"`
        : `  export ENGRAM_VAULT_KEY="<the key above>"`
    )
  );
  // A daemon started at login may not get a shell's variables: it reads
  // the file (engram#690).
  if (flags.save === undefined) {
    console.log(dim(`  Then '${engramCommand("vault save-key")}' saves it for the daemon started at login.`));
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
    console.error(dim(`  To make a new vault key and save it instead: ${engramCommand("vault keygen --save")}`));
    process.exit(1);
  }
  const key = envKey.trim();
  if (!isVaultKey(key)) {
    console.error(red("Error: ENGRAM_VAULT_KEY doesn't hold a vault key, so it isn't saved."));
    console.error(dim(`  A vault key is 32 bytes, base64-encoded, as '${engramCommand("vault keygen")}' makes one.`));
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
  await printDaemonKeyHint(false);
}

/**
 * The daemon running now: what it says of itself; "unknown" when it is
 * busy and doesn't say, or, from before engram#612, has no socket and only
 * its PID file names it; null when none runs, or the one running is
 * stopping.
 */
async function runningDaemon(): Promise<DaemonInfo | "unknown" | null> {
  const probe = await probeDaemon({ timeoutMs: 1_000 });
  if (probe.state === "answered") return probe.info.stopping ? null : probe.info;
  return probe.state === "silent" || confirmedDaemonInPidFile() !== null ? "unknown" : null;
}

/**
 * What the daemon running now does with the key just saved, when one runs.
 * One that reads its key again before sending (engram#693) uses it from
 * its next send on, unless it was started with ENGRAM_VAULT_KEY, which
 * wins over the file. One from before read its key when it started: a
 * restart reads it. So does one that doesn't say which it is.
 * `fresh`: a key just made, which no daemon can have had.
 */
async function printDaemonKeyHint(fresh: boolean): Promise<void> {
  const daemon = await runningDaemon();
  if (daemon === null) return;
  if (daemon !== "unknown" && daemon.vaultKeyReread) {
    console.log(
      dim(
        readStatus().vault_key === "env"
          ? "The daemon running now was started with ENGRAM_VAULT_KEY, which it uses instead of the file."
          : "The daemon running now reads it before its next send: no restart needed.",
      ),
    );
    return;
  }
  if (fresh) {
    console.log(dim("The daemon running now read its key when it started. For it to use this one,"));
    console.log(dim(`run '${engramCommand("stop")}', then '${engramCommand("start")}'.`));
  } else {
    console.log(dim("The daemon running now read its key when it started. If that was without this one,"));
    console.log(dim(`as at login, run '${engramCommand("stop")}', then '${engramCommand("start")}'.`));
  }
}

export async function vaultStatus(): Promise<void> {
  // The key every command uses: ENGRAM_VAULT_KEY wins over the file.
  const envKey = process.env.ENGRAM_VAULT_KEY;
  if (envKey) {
    const problem = whyNotVaultKey(envKey);
    if (problem === null) {
      console.log(`${bold("Vault:")} configured (key in ENGRAM_VAULT_KEY)`);
      console.log(fingerprintLine(envKey));
    } else {
      console.log(`${bold("Vault:")} invalid key in ENGRAM_VAULT_KEY (${problem})`);
    }
    // The daemon reads the file when started without it, as at login.
    const file = await vaultKeyFileState();
    if (file instanceof VaultKeyUnreadable) {
      console.log(red(`  ~/.engram/vault-key, which the daemon reads, ${file.problem}. See '${engramCommand("status")}'.`));
      return;
    }
    // Not saved there (engram#690). Not said for a key that isn't one.
    const saved = await envVaultKeyState();
    if (saved === "none") {
      console.log(red("  ~/.engram/vault-key isn't there: a daemon started at login may not have this key."));
      console.log(dim(`  To save it there, readable only by you: ${engramCommand("vault save-key")}`));
    } else if (saved === "different") {
      console.log(red("  ~/.engram/vault-key holds a different key: a daemon started at login may use that one."));
      console.log(dim(`  If this one is right: ${engramCommand("vault save-key --force")} (the file's key is backed up first)`));
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
    console.log(dim(`Run '${engramCommand("vault keygen --save")}' to generate a key.`));
    return;
  }
  const problem = whyNotVaultKey(key);
  if (problem === null) {
    console.log(`${bold("Vault:")} configured (key at ${VAULT_KEY_FILE})`);
    console.log(fingerprintLine(key));
  } else {
    console.log(`${bold("Vault:")} invalid key (${problem})`);
  }
}

/**
 * What tells this key from another, and shows none of it (engram#699):
 * `vault status` printed its first 8 characters, and what it prints may be
 * captured. Only for a vault key.
 */
function fingerprintLine(key: string): string {
  return dim(`Key fingerprint: ${vaultKeyFingerprint(key)}`);
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

  // Tell a running daemon to read the vault before its next send
  // (engram#701), whether the request went through or not: one cut short
  // may have saved the secret still.
  let told = false;
  try {
    await client.vault.set(name, value);
  } finally {
    told = noteVaultChanged();
  }
  console.log(`${bold("Secret stored:")} ${name}`);
  console.log(dim("Encrypted client-side. The server never sees the plaintext value."));
  await printDaemonVaultHint(told);
}

/**
 * Whether the daemon running now scrubs the secret just saved from its
 * next send on (engram#701). One that reads the vault again when told it
 * changed does, once `told`: the notice was written. One from before, or
 * one that doesn't say which it is, reads the vault every 10 minutes, and
 * until then sends the secret as it is: a restart reads it now.
 *
 * One with no vault key can't scrub it at all (engram#698). The key used
 * here is then ENGRAM_VAULT_KEY's, which that daemon never got: saved to
 * ~/.engram/vault-key, it is read before the next send.
 */
async function printDaemonVaultHint(told: boolean): Promise<void> {
  const daemon = await runningDaemon();
  if (daemon === null) return;
  if (daemon !== "unknown" && daemon.vaultKey === false && (await vaultKeyFileState()) === "none") {
    console.log(dim("The daemon running now has no vault key, so it can't remove this secret from what it captures."));
    console.log(dim(`To save this key where it reads it: ${engramCommand("vault save-key")}`));
    return;
  }
  const notices = daemon !== "unknown" && daemon.vaultChangeNotice;
  if (notices && told) return;
  if (notices) console.log(dim("Couldn't write ~/.engram/vault-changed to tell the daemon running now."));
  console.log(dim("The daemon running now reads the vault every 10 minutes, and may send this secret unscrubbed until then."));
  console.log(dim(`To have it scrubbed from now on, run '${engramCommand("stop")}', then '${engramCommand("start")}'.`));
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
 *   engram vault list --check   (which decrypt with this vault key)
 */
export async function vaultList(
  client: Engram,
  _args: string[],
  flags: Record<string, string>
): Promise<void> {
  const secrets = await client.vault.list();
  const checked = flags.check !== undefined ? await decrypting(client, secrets.map((s) => s.name)) : undefined;

  if (flags.json !== undefined) {
    const listed = checked ? secrets.map((s) => ({ ...s, decrypts: checked.get(s.name) ?? null })) : secrets;
    console.log(JSON.stringify({ secrets: listed, total: secrets.length }));
    return;
  }

  if (secrets.length === 0) {
    console.log(dim("No secrets stored."));
    console.log(dim(`Run '${engramCommand("vault set <NAME> <value>")}' to store one.`));
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
    const check = checked?.get(s.name);
    console.log(
      s.name.padEnd(nameWidth) +
      dim(s.secretType.padEnd(typeWidth)) +
      dim(updated) +
      (check === false ? red("  doesn't decrypt") : check === null ? dim("  couldn't check") : "")
    );
  }

  console.log();
  console.log(dim(plural(secrets.length, "secret")));
  if (checked) printDecryptCheck([...checked.values()]);
}

/**
 * Whether each secret decrypts with this vault key (engram#694): true,
 * false, or null when it couldn't be told, a request that failed, or a
 * secret deleted meanwhile. Each is read, as `vault get` reads one, and its
 * value is dropped at once: never printed, nor kept.
 */
async function decrypting(client: Engram, names: string[]): Promise<Map<string, boolean | null>> {
  const result = new Map<string, boolean | null>();
  for (const name of names) {
    try {
      result.set(name, typeof (await client.vault.get(name)) === "string" ? true : null);
    } catch (err: unknown) {
      result.set(name, decryptFailed(err) ? false : null);
    }
  }
  return result;
}

/** What `vault list --check` found, and what to do about the ones that don't decrypt. */
function printDecryptCheck(checks: Array<boolean | null>): void {
  const failed = checks.filter((c) => c === false).length;
  const unknown = checks.filter((c) => c === null).length;
  if (failed === 0 && unknown === 0) {
    console.log(dim(checks.length === 1 ? "It decrypts with this vault key." : "Each decrypts with this vault key."));
    return;
  }
  if (failed > 0) {
    const one = failed === 1;
    console.log(
      red(
        checks.length === 1
          ? "It doesn't decrypt with this vault key: it was saved with another."
          : `${failed} of them ${one ? "doesn't" : "don't"} decrypt with this vault key: saved with another.`,
      ),
    );
    // Each: the key they were saved with may be the fix. Some: it isn't,
    // as the others don't decrypt with it. Deleting one still in use stops
    // the daemon removing it from what it captures: saving it again doesn't.
    const them = one ? "it" : "each";
    console.log(
      dim(
        failed === checks.length
          ? `Put that key in ~/.engram/vault-key, or save ${them} again with this one`
          : `Save ${them} again with this key`,
      ),
    );
    console.log(
      dim(
        `(${engramCommand("vault set <NAME>")}), or delete ${one ? "it if you no longer use it" : "each you no longer use"} ` +
          `(${engramCommand("vault delete <NAME>")}).`,
      ),
    );
  }
  if (unknown > 0) console.log(dim(`${unknown} couldn't be checked: run this again.`));
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

  // A request cut short may have deleted it still.
  let deleted = true;
  try {
    deleted = await client.vault.delete(name);
  } finally {
    // A daemon reads the vault before its next send (engram#701): one held
    // for a secret its key doesn't decrypt can go on once it is deleted.
    if (deleted) noteVaultChanged();
  }
  if (!deleted) {
    console.error(`Secret "${name}" not found.`);
    process.exit(1);
  }

  console.log(`${bold("Deleted:")} ${name}`);
}
