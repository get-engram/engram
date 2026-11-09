import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * A program on PATH, from an absolute directory only: never one that PATH's
 * relative entries would find in the working directory. Null when there is
 * none.
 */
export function commandPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const file = join(dir, name);
    try {
      accessSync(file, constants.X_OK);
      if (statSync(file).isFile()) return file;
    } catch {
      // not here
    }
  }
  return null;
}

/**
 * What went wrong with a command, in a line, to print: the first line it
 * said on stderr, else the first line of the error. Never more than one
 * line, and never a long one.
 */
export function commandFailure(err: unknown): string {
  const stderr = (err as { stderr?: unknown }).stderr;
  const said = typeof stderr === "string" ? stderr.split("\n").find((l) => l.trim() !== "") : undefined;
  const line = (said ?? (err instanceof Error ? err.message : String(err)).split("\n")[0]).trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}
