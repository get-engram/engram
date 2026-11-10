/**
 * Reading the vault key without failing open (engram#677). Shared by the
 * CLI and the daemon.
 *
 * The vault key encrypts the secrets in the user's vault. With it, `engram
 * store` encrypts the secrets it finds before sending, and the daemon
 * scrubs the vault's values out of what it captures (scrubber.ts). A key
 * file that was there but couldn't be read used to count as no key: both
 * went on without it, and sent those secrets as they were, and nothing
 * said why. Now only a file that isn't there means no key. One that can't
 * be read stops what needs it: the daemon holds sends until it can be
 * read, and a command that would send content refuses.
 *
 * IMPORTANT: Node built-ins only, with config-file.js and
 * daemon/ownership.js, which are too. The daemon reads the key with this.
 */

import { readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMissing, readProblem } from "./config-file.js";
import { OWNERSHIP_FIX } from "./daemon/ownership.js";

export const VAULT_KEY_FILE = join(homedir(), ".engram", "vault-key");

/**
 * What is wrong with the file, which decides what fixes it. "gone": the
 * daemon held sends for a key it couldn't read, and now the file isn't
 * there (see scrubber.ts). Only the daemon says it: anywhere else, a file
 * that isn't there is no key.
 */
export type VaultKeyProblem = "permission" | "folder" | "link" | "empty" | "gone" | "other";

/**
 * ~/.engram/vault-key is there, but no key can be read from it. The
 * message names the problem and never quotes the file.
 */
export class VaultKeyUnreadable extends Error {
  /** What is wrong, worded to follow "vault-key", e.g. "is empty". */
  readonly problem: string;
  readonly kind: VaultKeyProblem;

  constructor(problem: string, kind: VaultKeyProblem) {
    super(`~/.engram/vault-key ${problem}`);
    this.name = "VaultKeyUnreadable";
    this.problem = problem;
    this.kind = kind;
  }
}

function readFailure(err: unknown): VaultKeyUnreadable {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  const kind: VaultKeyProblem =
    code === "EACCES" || code === "EPERM"
      ? "permission"
      : code === "EISDIR"
        ? "folder"
        : code === "ENOENT"
          ? "link"
          : "other";
  return new VaultKeyUnreadable(readProblem(err), kind);
}

/**
 * `err`, from reading the key, as a VaultKeyUnreadable. Reading it throws
 * nothing else; whatever else might is a key that can't be read too, so the
 * daemon holds on it rather than send without the key.
 */
export function asVaultKeyProblem(err: unknown): VaultKeyUnreadable {
  return err instanceof VaultKeyUnreadable ? err : new VaultKeyUnreadable("can't be read", "other");
}

/**
 * The key in ~/.engram/vault-key, or undefined when there is no such file.
 * Throws VaultKeyUnreadable when the file is there but no key can be read
 * from it. An empty file is one: a key that was there may have been lost,
 * and deleting the file is how to say there is no key.
 */
export async function readVaultKeyFile(): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(VAULT_KEY_FILE, "utf-8");
  } catch (err: unknown) {
    if (isMissing(err, VAULT_KEY_FILE)) return undefined;
    throw readFailure(err);
  }
  const key = text.trim();
  if (key === "") throw new VaultKeyUnreadable("is empty", "empty");
  return key;
}

/**
 * The vault key: ENGRAM_VAULT_KEY when it is set, which wins over the file;
 * else readVaultKeyFile's.
 */
export async function readVaultKey(): Promise<string | undefined> {
  const envKey = process.env.ENGRAM_VAULT_KEY;
  if (envKey) return envKey;
  return readVaultKeyFile();
}

/**
 * What ~/.engram/vault-key holds now: a key, nothing ("none": it isn't
 * there), or why no key can be read from it. The file alone: the daemon
 * reads it, and doesn't have the ENGRAM_VAULT_KEY a shell may set.
 */
export async function vaultKeyFileState(): Promise<"key" | "none" | VaultKeyUnreadable> {
  try {
    return (await readVaultKeyFile()) === undefined ? "none" : "key";
  } catch (err: unknown) {
    return asVaultKeyProblem(err);
  }
}

/**
 * The key's bytes as the SDK reads a key, with atob: base64, blanks
 * skipped. Null when it isn't base64.
 */
function keyBytes(key: string): string | null {
  try {
    return atob(key);
  } catch {
    return null;
  }
}

/** `key` is a vault key: 32 bytes, base64-encoded, as the SDK takes one. */
export function isVaultKey(key: string): boolean {
  return keyBytes(key)?.length === 32;
}

/**
 * The same key: the same bytes, however written (a line's end, padding).
 * Two that aren't base64 are the same when their text is.
 */
export function sameVaultKey(a: string, b: string): boolean {
  const x = keyBytes(a);
  const y = keyBytes(b);
  return x !== null && y !== null ? x === y : a.trim() === b.trim();
}

/**
 * The ways `key` may be written (engram#693): as given, trimmed; and, for a
 * vault key, base64 with its padding and without it, which the CLI and the
 * SDK take alike. The daemon scrubs each from what it captures. Longest
 * first is how to replace them: the padded spelling whole, before the
 * unpadded one, which it holds, could leave its "=" behind.
 */
export function vaultKeySpellings(key: string): string[] {
  const text = key.trim();
  const spellings = new Set([text]);
  const bytes = keyBytes(text);
  if (bytes?.length === 32) {
    const padded = btoa(bytes);
    spellings.add(padded);
    spellings.add(padded.replace(/=+$/, ""));
  }
  return [...spellings];
}

/**
 * ENGRAM_VAULT_KEY, which commands run in a shell use, against
 * ~/.engram/vault-key, which a daemon started at login reads: it may not
 * get a shell's variables (engram#690). "unset": ENGRAM_VAULT_KEY isn't
 * set. "invalid": it doesn't hold a vault key. "same": the file holds its
 * key. "none": there is no file. "different": the file holds another key.
 * Or why no key can be read from the file.
 */
export type EnvVaultKeyState = "unset" | "invalid" | "same" | "none" | "different" | VaultKeyUnreadable;

export async function envVaultKeyState(): Promise<EnvVaultKeyState> {
  const envKey = process.env.ENGRAM_VAULT_KEY;
  if (!envKey) return "unset";
  if (!isVaultKey(envKey)) return "invalid";
  let fileKey: string | undefined;
  try {
    fileKey = await readVaultKeyFile();
  } catch (err: unknown) {
    return asVaultKeyProblem(err);
  }
  if (fileKey === undefined) return "none";
  return sameVaultKey(envKey, fileKey) ? "same" : "different";
}

/**
 * ENGRAM_VAULT_KEY is set, and ~/.engram/vault-key holds it: a daemon
 * started without the variable, as launchd starts one, has the key too
 * (engram#690). Written the same, not only the same key: the daemon also
 * scrubs the key's own text from what it captures, and should scrub the
 * text set here. Read synchronously, to choose how to start the daemon.
 */
export function envVaultKeySaved(): boolean {
  const envKey = process.env.ENGRAM_VAULT_KEY?.trim();
  if (!envKey) return false;
  let text: string;
  try {
    text = readFileSync(VAULT_KEY_FILE, "utf-8");
  } catch {
    return false;
  }
  return text.trim() === envKey;
}

/** How to fix it, in a line. */
export function vaultKeyFix(problem: VaultKeyUnreadable): string {
  switch (problem.kind) {
    case "permission":
      if (ownedByAnother()) return `It isn't yours: make it yours with: ${OWNERSHIP_FIX}`;
      return process.platform === "win32"
        ? "Give your account permission to read it."
        : "Make it readable with: chmod 600 ~/.engram/vault-key";
    case "folder":
      return "Move the folder aside, and put your vault key back in ~/.engram/vault-key.";
    case "link":
      return "Connect the drive the link points to again, or put your vault key in its place.";
    case "empty":
      return "Put your vault key back in it. If you don't use the vault, delete the empty file.";
    case "gone":
      return (
        "Put your vault key back in it. If you don't use the vault, run 'engram stop', then " +
        "'engram start': the daemon starts without a key, and sends what it held."
      );
    default:
      return "Check the file, and the disk it is on.";
  }
}

/** The key file is another user's: root's, after `sudo engram …` (engram#659). */
function ownedByAnother(): boolean {
  // The effective user, as ownership.ts and private-files.ts judge it: the
  // one the read was refused to.
  const uid = process.geteuid?.();
  if (uid === undefined) return false;
  try {
    return statSync(VAULT_KEY_FILE).uid !== uid;
  } catch {
    return false;
  }
}
