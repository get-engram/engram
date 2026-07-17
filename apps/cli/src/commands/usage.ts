import { loadConfig, getBaseUrl } from "../config.js";
import { bold, dim, red, json as printJson } from "../output.js";

const API_URL = process.env.ENGRAM_BASE_URL ?? getBaseUrl();

/** Render a progress bar like "[████████████░░░░░░░░] 62%". Exported for tests. */
export function renderBar(used: number, limit: number, width = 20): string {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const filled = Math.min(width, Math.round((pct / 100) * width));
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${String(pct).padStart(3)}%`;
}

const fmt = (n: number) => n.toLocaleString("en-US");

interface UsageResponse {
  tier: string;
  period: string | null;
  messages: { used: number; limit: number };
  storage?: { used: number; limit: number };
  searches: { used: number };
}

/**
 * `engram usage` — show memory storage and monthly usage with visual bars.
 */
export async function usage(
  _args: string[],
  flags: Record<string, string>,
): Promise<void> {
  const config = await loadConfig();
  const apiKey = process.env.ENGRAM_API_KEY ?? config.apiKey;

  if (!apiKey) {
    console.error(red("Not authenticated. Run 'engram signup' first."));
    process.exit(1);
  }

  const res = await fetch(`${API_URL}/api/usage`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    console.error(red(`Failed to fetch usage (${res.status}).`));
    process.exit(1);
  }

  const data = (await res.json()) as UsageResponse;

  if ("json" in flags) {
    printJson(data);
    return;
  }

  console.log(`\n${bold("Plan:")} ${data.tier}\n`);

  if (data.storage) {
    if (data.storage.limit === -1) {
      console.log(`  ${bold("Memory")}       unlimited ${dim(`· ${fmt(data.storage.used)} messages stored · never expires`)}`);
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
      console.log(dim("  Memory is full — nothing expires, but new saves are paused."));
      console.log(dim("  Free space by deleting conversations, or upgrade: engram upgrade\n"));
    } else if (pct >= 0.8) {
      console.log(dim("  Heads up: memory is over 80% full. More room: engram upgrade\n"));
    }
  }
}
