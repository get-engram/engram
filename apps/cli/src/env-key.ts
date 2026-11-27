/**
 * ENGRAM_API_KEY against the key saved in ~/.engram/config.json
 * (engram#757). Set, it wins over config.json for every command run in that
 * shell and for a daemon started from it, which keeps it for its lifetime.
 * On Windows a user environment variable also reaches the daemon that starts
 * at sign-in. `engram auth login` and `engram login` saved a key to
 * config.json and said nothing when the variable held another one: the
 * saved key went unused, the old one kept being sent and refused, and
 * nothing named the variable as the reason.
 */

import { engramCommand } from "./daemon/package-runner.js";
import { red } from "./output.js";

/** A key's first characters, as `engram auth status` shows them. */
const prefix = (key: string): string => `${key.slice(0, 20)}...`;

/**
 * ENGRAM_API_KEY when it is set to a key other than `saved`. Empty is
 * unset, as the daemon reads it.
 */
export function envKeyOtherThan(saved: string | undefined): string | undefined {
  const env = process.env.ENGRAM_API_KEY || undefined;
  return env !== undefined && env !== saved ? env : undefined;
}

/**
 * What to say once `saved` is in config.json while ENGRAM_API_KEY holds
 * another key: that the variable wins, where, and how to use the saved key.
 * Nothing when the variable is unset or holds the same key.
 */
export function envKeyWinsLines(saved: string): string[] {
  const env = envKeyOtherThan(saved);
  if (env === undefined) return [];
  const lines = [
    `ENGRAM_API_KEY is set to another key (${prefix(env)}), and it wins over the one saved:`,
    "commands run in this shell, and a daemon started from it, keep using ENGRAM_API_KEY.",
    `To use the saved key, unset it, then run '${engramCommand("stop")}' and '${engramCommand("start")}'.`,
  ];
  if (process.platform === "win32") {
    lines.push(
      "If it is one of your Windows user environment variables, remove it there too:",
      "the daemon that starts when you sign in gets those.",
    );
  }
  return lines;
}

/** Print envKeyWinsLines for `saved`, if there are any. */
export function warnIfEnvKeyWins(saved: string): void {
  for (const line of envKeyWinsLines(saved)) console.log(red(`  ${line}`));
}

/**
 * The line `engram auth status` and `engram whoami` add when ENGRAM_API_KEY
 * is the key in use and config.json holds another, which is then unused.
 */
export function savedKeyUnusedLine(saved: string | undefined): string | undefined {
  if (!saved || envKeyOtherThan(saved) === undefined) return undefined;
  return `~/.engram/config.json holds another key (${prefix(saved)}), unused while ENGRAM_API_KEY is set.`;
}
