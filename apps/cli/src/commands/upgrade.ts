import { loadConfig, getBaseUrl } from "../config.js";
import { green, red, dim } from "../output.js";

const API_URL = process.env.ENGRAM_BASE_URL ?? getBaseUrl();

/**
 * `engram upgrade [pro|team]` — create a Stripe Checkout session and open it.
 * Works for both humans (opens browser) and agents (returns URL).
 */
export async function upgrade(
  args: string[],
  flags: Record<string, string>,
): Promise<void> {
  const config = await loadConfig();
  const apiKey = process.env.ENGRAM_API_KEY ?? config.apiKey;

  if (!apiKey) {
    console.error(red("Not authenticated. Run 'engram signup' first."));
    process.exit(1);
  }

  const plan = args[0] === "team" ? "team" : "pro";
  const json = "json" in flags;

  const res = await fetch(`${API_URL}/api/billing/checkout`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ plan }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };

    if (body.error === "missing_email") {
      console.error(
        red("Your account needs an email before upgrading.\n") +
          "\n  Link an email to this account:\n" +
          "    engram link --email you@example.com --password <password>\n" +
          "\n  Or if you already have an account, sign in:\n" +
          "    engram login --email you@example.com --password <password>\n",
      );
      process.exit(1);
    }

    console.error(red(body.message || `Upgrade failed: ${res.status}`));
    process.exit(1);
  }

  const data = (await res.json()) as {
    url: string;
    session_id: string;
    plan: string;
  };

  if (json) {
    console.log(JSON.stringify(data));
    return;
  }

  console.log(green(`✓ Checkout session created for ${data.plan}`));
  console.log(`\n  ${data.url}\n`);

  // Try to open in browser
  try {
    const { exec } = await import("node:child_process");
    const cmd =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "start"
          : "xdg-open";
    exec(`${cmd} "${data.url}"`);
    console.log(dim("  Opening in your browser..."));
  } catch {
    console.log(dim("  Open the URL above to complete checkout."));
  }
}
