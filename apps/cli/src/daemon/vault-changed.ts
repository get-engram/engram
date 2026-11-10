/**
 * `engram vault set` and `engram vault delete` tell a running daemon that
 * the vault changed (engram#701). The daemon then reads the vault again
 * before its next send, rather than within its 10-minute interval, so a
 * secret saved while it runs is scrubbed from the next capture on.
 *
 * The notice is a file in ~/.engram, not a message on the daemon's socket:
 * the socket only answers (see instance.ts), and ~/.engram is the user's
 * alone (engram#627). All the file says is that the vault changed. The
 * daemon reads the vault itself from the server and takes nothing else
 * from the file.
 *
 * IMPORTANT: Node built-ins only, as for private-files.ts.
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { ENGRAM_DIR } from "./launch.js";
import { readSmallFileSync, writePrivateFileSync } from "../private-files.js";

export const VAULT_CHANGED_FILE = join(ENGRAM_DIR, "vault-changed");

/** Larger than any notice noteVaultChanged writes: a larger file isn't one. */
const MAX_NOTICE_BYTES = 256;

/**
 * Tell a running daemon that the vault changed. False when the notice
 * couldn't be written. With no ~/.engram it isn't made here: no daemon has
 * run here then.
 */
export function noteVaultChanged(file: string = VAULT_CHANGED_FILE): boolean {
  try {
    // Not flushed to disk: after a power cut the daemon starts again, and
    // reads the whole vault as it starts.
    writePrivateFileSync(file, `${new Date().toISOString()} ${randomBytes(8).toString("hex")}\n`, { durable: false });
    return true;
  } catch {
    return false;
  }
}

/**
 * Which notice is in the file, or null when there is none. Every notice
 * says something of its own, so one that differs from the last read means
 * the vault changed since then. What it says is all that counts: the file
 * touched, or put back as it was, is the same notice.
 */
export function readVaultChanged(file: string = VAULT_CHANGED_FILE): string | null {
  return readSmallFileSync(file, MAX_NOTICE_BYTES)?.data.toString("hex") ?? null;
}
