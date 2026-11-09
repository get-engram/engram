/** Formatting helpers for CLI output */

export function json(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function table(
  rows: Record<string, unknown>[],
  columns: string[],
): void {
  if (rows.length === 0) {
    console.log("  (none)");
    return;
  }

  // Calculate column widths
  const widths = columns.map((col) =>
    Math.max(
      col.length,
      ...rows.map((r) => String(r[col] ?? "").length),
    ),
  );

  // Header
  const header = columns
    .map((col, i) => col.toUpperCase().padEnd(widths[i]))
    .join("  ");
  console.log(header);
  console.log(columns.map((_, i) => "─".repeat(widths[i])).join("  "));

  // Rows
  for (const row of rows) {
    const line = columns
      .map((col, i) => String(row[col] ?? "").padEnd(widths[i]))
      .join("  ");
    console.log(line);
  }
}

/**
 * Whether what the CLI prints gets colors (engram#628): only when stdout
 * and stderr are both terminals, since a colored string can go to either.
 * Pipes, files and CI logs used to get the raw escape codes. NO_COLOR set
 * to anything but "" turns colors off (https://no-color.org), and so does
 * a terminal that can't show them (TERM=dumb).
 */
export function colorEnabled(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.TERM === "dumb") return false;
  return Boolean(process.stdout.isTTY && process.stderr.isTTY);
}

function paint(code: string, text: string): string {
  return colorEnabled() ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export function dim(text: string): string {
  return paint("2", text);
}

export function bold(text: string): string {
  return paint("1", text);
}

export function green(text: string): string {
  return paint("32", text);
}

export function red(text: string): string {
  return paint("31", text);
}

export function cyan(text: string): string {
  return paint("36", text);
}

/**
 * A count and its noun, singular for exactly one (engram#628): "1 message",
 * "0 messages", "1,234 messages". `many` is for a noun that doesn't just
 * add an "s" ("copy", "copies").
 */
export function plural(count: number, one: string, many = `${one}s`): string {
  // A count that isn't a number after all is printed as it is, as the
  // template strings this replaced did, instead of throwing.
  const shown = Number.isFinite(count) ? count.toLocaleString("en-US") : String(count);
  return `${shown} ${count === 1 ? one : many}`;
}
