import { dim } from "../output.js";
import { daemonStatus } from "../daemon/index.js";
import { fetchUsage, printUsage, printUsageError, usage } from "./usage.js";

/**
 * `engram status`: the daemon on this machine, then the account's plan and
 * usage (engram#609).
 *
 * It used to be an alias of `engram usage`. The alias shadowed the daemon
 * status that the help, the docs, and every "run 'engram status'" message
 * describe.
 *
 * The daemon half needs no network, so it comes first and always prints.
 * When the API can't be reached, the usage half is one dim line, not a
 * failure. A missing or rejected key still fails the command: the daemon
 * can't sync without a key, and the daemon's rejected-key notices send
 * people here to find out (engram#587).
 */
export async function status(
  args: string[],
  flags: Record<string, string>,
): Promise<void> {
  // Scripts parse `engram status --json`, which has always printed the usage JSON.
  if ("json" in flags) {
    await usage(args, flags);
    return;
  }

  await daemonStatus();

  const result = await fetchUsage();
  switch (result.kind) {
    case "ok":
      printUsage(result.data);
      return;
    case "unreachable":
      console.log(dim(`\nPlan and usage: couldn't reach ${result.url}.`));
      return;
    case "failed":
      console.log(dim(`\nPlan and usage: unavailable right now (${result.status}).`));
      return;
    default:
      console.error("");
      printUsageError(result);
      process.exitCode = 1;
  }
}
