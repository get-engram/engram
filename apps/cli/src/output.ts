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

export function dim(text: string): string {
  return `\x1b[2m${text}\x1b[0m`;
}

export function bold(text: string): string {
  return `\x1b[1m${text}\x1b[0m`;
}

export function green(text: string): string {
  return `\x1b[32m${text}\x1b[0m`;
}

export function red(text: string): string {
  return `\x1b[31m${text}\x1b[0m`;
}

export function cyan(text: string): string {
  return `\x1b[36m${text}\x1b[0m`;
}
