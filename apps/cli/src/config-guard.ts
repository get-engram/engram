/**
 * Commands, and a ~/.engram/config.json they can't read (engram#673).
 *
 * The file holds the API key and the folders excluded from capture. Read
 * leniently, a file that couldn't be read or parsed read as no settings: a
 * command that saved it then replaced it, and the key and the excluded
 * folders were gone for good; one that used the key said "not signed in",
 * or sent ENGRAM_API_KEY to the default server instead of the configured
 * one (engram#625). These read it strictly and stop instead, saying why.
 *
 * An empty file is the exception. There is nothing in it to lose, so a
 * command reads it as no settings and may save over it, saying that any
 * folders that were excluded have to be added back; the daemon still holds
 * capture for it (exclusions.ts), since a file being written in place is
 * empty for a moment.
 */

import { configSaveProblem, loadConfigStrict, saveConfig, saveFailure, type Config } from "./config.js";
import { ConfigUnreadable, excludePathsOf } from "./config-file.js";
import { lockedDir, lockedDirFix, lockedDirReason, type LockedDir } from "./daemon/ownership.js";
import { engramCommand } from "./daemon/package-runner.js";
import { dim, red } from "./output.js";

function asProblem(err: unknown): ConfigUnreadable {
  return err instanceof ConfigUnreadable ? err : new ConfigUnreadable("can't be read");
}

/**
 * A ~/.engram the user can't search (engram#723), when that is why
 * config.json couldn't be read: then the folder is what's wrong, and
 * nothing in the file. Null for an empty file, which was read.
 */
export function lockedConfigDir(problem: ConfigUnreadable): LockedDir | null {
  if (problem.empty) return null;
  const locked = lockedDir();
  return locked?.search ? locked : null;
}

/**
 * config.json's settings, or what is wrong with it: what the daemon holds
 * capture for, an excludePaths it can't use among it. A file that isn't
 * there reads as no settings. Never throws.
 */
export async function inspectConfig(): Promise<
  { config: Config; problem: null } | { config: null; problem: ConfigUnreadable }
> {
  try {
    const config = await loadConfigStrict();
    excludePathsOf(config);
    return { config, problem: null };
  } catch (err: unknown) {
    return { config: null, problem: asProblem(err) };
  }
}

/** What is wrong with config.json, or null: see inspectConfig. */
export async function configProblem(): Promise<ConfigUnreadable | null> {
  return (await inspectConfig()).problem;
}

/**
 * config.json's settings, for a command that changes one and saves them
 * back. When they can't be read, the command stops with nothing changed.
 * `hints` are said after the fix, e.g. another way to do what was asked.
 * They aren't said when ~/.engram itself is what's in the way (engram#723):
 * a way around the file reaches into the folder too, and once the folder
 * is fixed, the command does what was asked.
 */
export async function loadConfigForUpdate(hints: string[] = []): Promise<Config> {
  try {
    return await loadConfigStrict();
  } catch (err: unknown) {
    const problem = asProblem(err);
    if (problem.empty) {
      printEmptyConfigNote();
      return {};
    }
    const locked = lockedConfigDir(problem);
    if (locked) {
      console.error(red(`Error: ${lockedDirReason("opening config.json")}, so nothing was changed.`));
      console.error(`  ${lockedDirFix(locked)}`);
      console.error("  Then run this again.");
      process.exit(1);
    }
    console.error(red(`Error: ${problem.message}.`));
    console.error("  Saving now would replace everything in it, your API key and the folders you");
    console.error("  excluded from capture among them, so nothing was changed.");
    console.error("  Fix the file, then run this again.");
    for (const hint of hints) console.error(`  ${hint}`);
    process.exit(1);
  }
}

/**
 * Said on stderr by a command that saves settings into an empty
 * config.json: what the file listed as excluded from capture is gone, and
 * from then on the daemon captures from those folders again.
 */
export function printEmptyConfigNote(): void {
  console.error(dim("Note: ~/.engram/config.json was empty, so any folders you had excluded from"));
  console.error(dim(`  capture are lost. Add them back with: ${engramCommand("exclude add <path>")}`));
}

/**
 * config.json's settings, for a command that uses the key or the server in
 * them, or what is wrong with the file. With ENGRAM_API_KEY and
 * ENGRAM_BASE_URL both set, the file isn't needed.
 */
export async function configForUse(): Promise<{ config: Config } | { problem: ConfigUnreadable }> {
  try {
    return { config: await loadConfigStrict() };
  } catch (err: unknown) {
    const problem = asProblem(err);
    if (problem.empty || (process.env.ENGRAM_API_KEY && process.env.ENGRAM_BASE_URL)) {
      return { config: {} };
    }
    return { problem };
  }
}

/** Say on stderr that a command can't run because config.json can't be read. */
export function printConfigProblemForUse(problem: ConfigUnreadable): void {
  const locked = lockedConfigDir(problem);
  if (locked) {
    console.error(
      red(`Error: ${lockedDirReason("opening config.json")}, so Engram can't tell which account or server to use.`),
    );
    console.error(`  ${lockedDirFix(locked)}`);
    console.error("  Then run this again.");
    return;
  }
  console.error(red(`Error: ${problem.message}, so Engram can't tell which account or server to use.`));
  console.error("  Fix the file, then run this again.");
}

/**
 * config.json's settings, for a command that uses the key or the server in
 * them. When they can't be read, the command stops, saying why.
 */
export async function loadConfigForUse(): Promise<Config> {
  const read = await configForUse();
  if ("problem" in read) {
    printConfigProblemForUse(read.problem);
    process.exit(1);
  }
  return read.config;
}

/**
 * Commands, and a config.json they can read but not write (engram#717).
 * A save that failed ended the command with Node's own error, which named
 * the path and nothing else, after `engram login` and `engram signup` had
 * made the API key that the save then lost. These say why it can't be
 * written, what that means for the command, and what fixes it, and the
 * command exits 1.
 *
 * `meaning`: what the command didn't do, said after why. `again`: the
 * command to run once it's fixed; without it, "this", for one whose
 * arguments shouldn't be repeated, such as a key.
 */
export function exitConfigUnsaved(
  failure: { problem: string; fix: string | null },
  meaning: string[],
  again?: string,
): never {
  const command = again === undefined ? "this" : `'${engramCommand(again)}'`;
  console.error(red(`Error: ${failure.problem}.`));
  for (const line of meaning) console.error(`  ${line}`);
  if (failure.fix) {
    console.error(`  To fix it, run: ${failure.fix}`);
    console.error(`  Then run ${command} again.`);
  } else {
    console.error(`  Once it's fixed, run ${command} again.`);
  }
  process.exit(1);
}

/**
 * Stop, as exitConfigUnsaved does, when config.json can't be written now:
 * before a command does what a failed save would waste, such as making an
 * account or an API key. Nothing is written.
 */
export function requireWritableConfig(meaning: string[], again?: string): void {
  const failure = configSaveProblem();
  if (failure) exitConfigUnsaved(failure, meaning, again);
}

/** Save config.json, or stop as exitConfigUnsaved does. */
export async function saveConfigOrExit(config: Config, meaning: string[], again?: string): Promise<void> {
  try {
    await saveConfig(config);
  } catch (err: unknown) {
    exitConfigUnsaved(saveFailure(err), meaning, again);
  }
}
