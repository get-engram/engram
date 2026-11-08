import { loadConfig, saveConfig } from "../config.js";
import { normalizeExcludePath, samePath, IGNORE_MARKER } from "../daemon/exclusions.js";
import { bold, dim } from "../output.js";

// `engram exclude` — keep whole repos/directories out of capture (engram#462).
// The daemon hot-reloads the list (mtime check on config.json), so changes
// apply to the next captured batch with no restart.

export async function excludeAdd(args: string[]): Promise<void> {
  const target = normalizeExcludePath(args[0] ?? process.cwd());
  const config = await loadConfig();
  const paths = config.excludePaths ?? [];
  // On macOS and Windows, ~/Code/x and ~/code/x are one directory (engram#619).
  const existing = paths.find((p) => samePath(p, target));
  if (existing !== undefined) {
    console.log(`${bold("Already excluded:")} ${existing}`);
    return;
  }
  config.excludePaths = [...paths, target].sort();
  await saveConfig(config);
  console.log(`${bold("Excluded from capture:")} ${target}`);
  console.log(dim("Sessions in this directory (and below) will not be saved to Engram."));
  console.log(dim("Applies immediately — no daemon restart needed. Already-captured"));
  console.log(dim("sessions are unaffected; delete those from the dashboard if needed."));
}

export async function excludeRemove(args: string[]): Promise<void> {
  const target = normalizeExcludePath(args[0] ?? process.cwd());
  const config = await loadConfig();
  const paths = config.excludePaths ?? [];
  const removed = paths.filter((p) => samePath(p, target));
  if (removed.length === 0) {
    console.error(`Not in the exclude list: ${target}`);
    console.error(dim("Run 'engram exclude list' to see current exclusions."));
    process.exit(1);
  }
  config.excludePaths = paths.filter((p) => !samePath(p, target));
  await saveConfig(config);
  console.log(`${bold("Removed from exclusions:")} ${removed.join(", ")}`);
  console.log(dim("New sessions in this directory will be captured again."));
}

export async function excludeList(): Promise<void> {
  const config = await loadConfig();
  const paths = config.excludePaths ?? [];
  if (paths.length === 0) {
    console.log(dim("No excluded paths."));
  } else {
    console.log(bold("Excluded from capture:"));
    for (const p of paths) console.log(`  ${p}`);
  }
  console.log();
  console.log(dim(`Also honored: a ${IGNORE_MARKER} file at a repo root excludes that`));
  console.log(dim(`repo for everyone (commit it to share), and saying "don't save`));
  console.log(dim(`this to engram" in a session excludes and erases that session.`));
}
