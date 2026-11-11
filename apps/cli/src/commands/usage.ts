import { resolveBaseUrl } from "../config.js";
import type { ConfigUnreadable } from "../config-file.js";
import { configForUse, printConfigProblemForUse } from "../config-guard.js";
import { bold, dim, red, plural, json as printJson } from "../output.js";
import { readStatus } from "../daemon/status.js";
import { engramCommand } from "../daemon/package-runner.js";


/** How long to wait for the API before calling it unreachable. */
const USAGE_TIMEOUT_MS = 15_000;

/** Render a progress bar like "[████████████░░░░░░░░] 62%". Exported for tests. */
export function renderBar(used: number, limit: number, width = 20): string {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  // Any nonzero usage shows at least one filled segment so the bar never
  // reads as empty (an all-░ bar renders as a blank grey pill in many fonts).
  const minFilled = used > 0 && limit > 0 ? 1 : 0;
  const filled = Math.max(minFilled, Math.min(width, Math.round((pct / 100) * width)));
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${String(pct).padStart(3)}%`;
}

const fmt = (n: number) => n.toLocaleString("en-US");

export interface UsageResponse {
  tier: string;
  period: string | null;
  messages: { used: number; limit: number };
  storage?: { used: number; limit: number };
  searches: { used: number };
}

/** What asking the API for the account's plan and usage came to. */
export type UsageResult =
  | { kind: "ok"; data: UsageResponse }
  | { kind: "signed-out" }
  /** ~/.engram/config.json can't be read (engram#673). */
  | { kind: "config"; problem: ConfigUnreadable }
  | { kind: "rejected" }
  | { kind: "failed"; status: number }
  | { kind: "unreachable"; url: string };

/** Fetch the account's plan and usage. Never throws. */
export async function fetchUsage(): Promise<UsageResult> {
  // Strict (engram#673): one that can't be read isn't "not authenticated",
  // and ENGRAM_API_KEY isn't sent to the default server in place of the
  // one it names.
  const read = await configForUse();
  if ("problem" in read) return { kind: "config", problem: read.problem };
  const config = read.config;
  const baseUrl = resolveBaseUrl(config);
  const apiKey = process.env.ENGRAM_API_KEY ?? config.apiKey;
  if (!apiKey) return { kind: "signed-out" };

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/usage`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
    });
  } catch {
    // Offline, a DNS failure, a refused connection, or no answer in time.
    return { kind: "unreachable", url: baseUrl };
  }
  if (res.status === 401 || res.status === 403) return { kind: "rejected" };
  if (!res.ok) return { kind: "failed", status: res.status };
  try {
    return { kind: "ok", data: (await res.json()) as UsageResponse };
  } catch {
    return { kind: "failed", status: res.status };
  }
}

/** Say on stderr why the plan and usage couldn't be shown. */
export function printUsageError(result: Exclude<UsageResult, { kind: "ok" }>): void {
  switch (result.kind) {
    case "signed-out":
      console.error(red(`Not authenticated. Run '${engramCommand("signup")}' first.`));
      break;
    case "config":
      printConfigProblemForUse(result.problem);
      break;
    case "rejected":
      // Every rejected-key notice the daemon gives says to run `engram
      // status`, which shows this, so a bare "Failed to fetch usage (401)"
      // was a dead end at exactly the moment someone followed it
      // (engram#587).
      console.error(red(`Your API key was rejected — run '${engramCommand("auth login")}'.`));
      if (process.env.ENGRAM_API_KEY) {
        console.error(
          dim(`  ENGRAM_API_KEY is set in this shell, and it is used in place of the key '${engramCommand("auth login")}' saves.`),
        );
      }
      break;
    case "failed":
      console.error(red(`Failed to fetch usage (${result.status}).`));
      break;
    case "unreachable":
      console.error(red(`Couldn't reach Engram at ${result.url}.`));
      break;
  }
}

/**
 * `engram usage` — show memory storage and monthly usage with visual bars.
 */
export async function usage(
  _args: string[],
  flags: Record<string, string>,
): Promise<void> {
  const result = await fetchUsage();
  if (result.kind !== "ok") {
    printUsageError(result);
    process.exit(1);
  }

  if ("json" in flags) {
    printJson(result.data);
    return;
  }

  printUsage(result.data);
}

/** The plan, the meters, and any memory-full warning. */
export function printUsage(data: UsageResponse): void {
  console.log(`\n${bold("Plan:")} ${data.tier}\n`);

  if (data.storage) {
    if (data.storage.limit === -1) {
      console.log(`  ${bold("Memory")}       unlimited ${dim(`· ${plural(data.storage.used, "message")} stored · never expires`)}`);
    } else {
      console.log(
        `  ${bold("Memory")}       ${renderBar(data.storage.used, data.storage.limit)}  ` +
          `${fmt(data.storage.used)} / ${fmt(data.storage.limit)} messages ${dim("· never expires")}`,
      );
    }
  }

  if (data.messages.limit !== -1) {
    console.log(
      `  ${bold("This month")}   ${renderBar(data.messages.used, data.messages.limit)}  ` +
        `${fmt(data.messages.used)} / ${fmt(data.messages.limit)} messages`,
    );
  }

  console.log(`  ${bold("Searches")}     ${fmt(data.searches.used)} this month\n`);

  if (data.storage && data.storage.limit > 0) {
    const pct = data.storage.used / data.storage.limit;
    if (pct >= 1) {
      // Not dim: this is the one state where the product has silently
      // stopped doing its job, and it needs to read that way.
      console.log(red(bold("  Memory is full — new saves are paused.")));
      console.log("  Nothing already saved expires or is lost.");

      // Background captures keep queueing locally while capped. Left
      // unsaid, auto-capture looks like it's still working.
      const queued = readStatus().pending_messages;
      if (queued > 0) {
        console.log(
          red(
            `  ${fmt(queued)} captured message${queued === 1 ? "" : "s"} ` +
              `waiting on this machine — they will not be saved until you free space.`,
          ),
        );
      }
      console.log(`  Free space by deleting conversations, or upgrade: ${engramCommand("upgrade")}\n`);
    } else if (pct >= 0.8) {
      console.log(dim(`  Heads up: memory is over 80% full. More room: ${engramCommand("upgrade")}\n`));
    }
  }
}
