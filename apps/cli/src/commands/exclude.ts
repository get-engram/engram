import { loadConfigStrict, type Config } from "../config.js";
import { ConfigUnreadable, excludePathsOf } from "../config-file.js";
import { loadConfigForUpdate, lockedConfigDir, saveConfigOrExit } from "../config-guard.js";
import { lockedDirFix, lockedDirReason } from "../daemon/ownership.js";
import { normalizeExcludePath, samePath, IGNORE_MARKER } from "../daemon/exclusions.js";
import { bold, dim, red } from "../output.js";

// `engram exclude` — keep whole repos/directories out of capture (engram#462).
// The daemon checks config.json for changes before each captured batch, so
// changes apply to the next one with no restart.

/**
 * Stop, saying why the excluded folders can't be `what` (engram#673): what
 * is wrong with config.json, or that ~/.engram itself keeps it from being
 * opened (engram#723), when nothing in the file needs fixing.
 */
function cantUse(err: unknown, what: string): never {
  const locked = err instanceof ConfigUnreadable ? lockedConfigDir(err) : null;
  const why = locked
    ? lockedDirReason("opening config.json")
    : err instanceof ConfigUnreadable
      ? err.message
      : "~/.engram/config.json can't be read";
  console.error(red(`Error: ${why}, so the folders excluded from capture can't be ${what}.`));
  if (locked) {
    console.error(`  ${lockedDirFix(locked)}`);
    console.error("  Then run this again.");
  } else {
    console.error("  Fix the file, then run this again.");
  }
  process.exit(1);
}

/**
 * config.json's settings and the folders excluded in them, for a command
 * that changes the list and saves the file (engram#673). Read leniently, a
 * file that couldn't be read was saved with only the one change: the API
 * key and every other excluded folder were gone.
 */
async function loadForUpdate(): Promise<{ config: Config; paths: string[] }> {
  const config = await loadConfigForUpdate();
  try {
    return { config, paths: excludePathsOf(config) };
  } catch (err: unknown) {
    cantUse(err, "changed");
  }
}

export async function excludeAdd(args: string[]): Promise<void> {
  const target = normalizeExcludePath(args[0] ?? process.cwd());
  const { config, paths } = await loadForUpdate();
  // On macOS and Windows, ~/Code/x and ~/code/x are one directory (engram#619).
  const existing = paths.find((p) => samePath(p, target));
  if (existing !== undefined) {
    console.log(`${bold("Already excluded:")} ${existing}`);
    return;
  }
  config.excludePaths = [...paths, target].sort();
  await saveConfigOrExit(config, [`Not excluded: sessions in ${target} are still captured.`]);
  console.log(`${bold("Excluded from capture:")} ${target}`);
  console.log(dim("Sessions in this directory (and below) will not be saved to Engram."));
  console.log(dim("Applies immediately — no daemon restart needed. Already-captured"));
  console.log(dim("sessions are unaffected; delete those from the dashboard if needed."));
}

export async function excludeRemove(args: string[]): Promise<void> {
  const target = normalizeExcludePath(args[0] ?? process.cwd());
  const { config, paths } = await loadForUpdate();
  const removed = paths.filter((p) => samePath(p, target));
  if (removed.length === 0) {
    console.error(`Not in the exclude list: ${target}`);
    console.error(dim("Run 'engram exclude list' to see current exclusions."));
    process.exit(1);
  }
  config.excludePaths = paths.filter((p) => !samePath(p, target));
  await saveConfigOrExit(config, [`Still excluded from capture: ${removed.join(", ")}`]);
  console.log(`${bold("Removed from exclusions:")} ${removed.join(", ")}`);
  console.log(dim("New sessions in this directory will be captured again."));
}

export async function excludeList(): Promise<void> {
  let paths: string[];
  try {
    paths = excludePathsOf(await loadConfigStrict());
  } catch (err: unknown) {
    if (!(err instanceof ConfigUnreadable && err.empty)) cantUse(err, "listed");
    // Capture waits on it (engram#673), and what it listed is gone.
    console.error(red("~/.engram/config.json is empty, so capture waits. Add back any folders you had"));
    console.error(red("  excluded ('engram exclude add <path>'), then sign in again ('engram login')."));
    console.error("");
    paths = [];
  }
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
