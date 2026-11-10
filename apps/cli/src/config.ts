import { lstatSync, statSync, type Stats } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensurePrivateDirSync, writePrivateFileSync } from "./private-files.js";
import { isMissing, parseConfigText, readFailure, writeProblem } from "./config-file.js";

// Where it always was, for the commands that import it from here.
export { resolveBaseUrl } from "./server-url.js";

const CONFIG_DIR = join(homedir(), ".engram");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export interface Config {
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

/**
 * The settings in ~/.engram/config.json: none when there is no such file.
 * One that exists and can't be read or parsed THROWS a ConfigUnreadable,
 * never reads as no settings. The daemon re-reads the key every couple of
 * seconds and treats "no key" as a logout (engram#594), so a file caught
 * half-written, or one damaged by hand, must not look like one: that would
 * stop capture for nothing. And a command that saved over it would replace
 * the key and the excluded folders in it (engram#673).
 *
 * There is no lenient version on purpose: reading a damaged file as no
 * settings, then saving, is how the key and the exclusions were lost. The
 * error never quotes the file, which holds the key: the daemon logs it.
 */
export async function loadConfigStrict(): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(CONFIG_FILE, "utf-8");
  } catch (err: unknown) {
    if (isMissing(err, CONFIG_FILE)) return {};
    throw readFailure(err);
  }
  return parseConfigText(raw) as Config;
}

/**
 * config.json holds the API key, so it and ~/.engram are the user's alone
 * (engram#627), and it is replaced in one step: the daemon reads it every
 * few seconds, and a save cut short leaves the old file whole instead of a
 * truncated one without the key.
 */
export async function saveConfig(config: Config): Promise<void> {
  ensurePrivateDirSync(CONFIG_DIR);
  writePrivateFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
}

/**
 * Why saveConfig failed, as "~/.engram/config.json can't be written: …",
 * and the command that fixes it, if there is one (engram#681): there is
 * when ~/.engram or config.json is the user's and only lacks its write
 * permission. Files that are another user's are said before the command,
 * with their chown (engram#659). A full or read-only disk, a file locked
 * some other way (EPERM: chmod can't change a locked file), or a
 * config.json that is a link has none. The error's message, which names
 * the path, is never quoted.
 */
export function saveFailure(err: unknown): { problem: string; fix: string | null } {
  return { problem: `~/.engram/config.json ${writeProblem(err)}`, fix: writableFix(err) };
}

/** `chmod u+w` for what lacks its write permission, when that is all that's wrong. */
function writableFix(err: unknown): string | null {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code !== "EACCES" || process.platform === "win32") return null;
  const uid = process.geteuid?.();
  const unwritable: string[] = [];
  const looked: [string, string][] = [
    [CONFIG_DIR, "~/.engram"],
    [CONFIG_FILE, "~/.engram/config.json"],
  ];
  for (const [path, shown] of looked) {
    let st: Stats;
    try {
      // Through a link, the file and the folder its new copy is made in are
      // elsewhere.
      if (path === CONFIG_FILE && lstatSync(path).isSymbolicLink()) return null;
      st = statSync(path);
    } catch {
      continue; // not there, so nothing to make writable
    }
    if (st.uid !== uid) return null;
    if ((st.mode & 0o200) === 0) unwritable.push(shown);
  }
  return unwritable.length > 0 ? `chmod u+w ${unwritable.join(" ")}` : null;
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
