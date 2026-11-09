import { spawn } from "node:child_process";
import { win32 } from "node:path";
import { loadConfig, resolveBaseUrl } from "../config.js";
import { green, red, dim } from "../output.js";


/**
 * The program, and its arguments, that opens `url` in the default browser:
 * run directly, never through a shell, or null when `url` is not a web URL.
 *
 * Through a shell (the old `exec(\`${cmd} "${url}"\`)`) it went wrong twice
 * (engram#602). On Windows, `start` takes its first quoted argument as the
 * new window's title, so it opened an empty console window titled with the
 * checkout URL instead of the browser. And on every platform the URL was
 * parsed by a shell, where a quote, a backtick or `$(…)` in it ends the
 * quoting and runs as a command. rundll32's FileProtocolHandler is the
 * shell-free way to hand a URL to the Windows default browser.
 *
 * Only http(s): `open` and FileProtocolHandler would just as happily launch
 * a local program from a `file:` URL.
 *
 * The opener is named by its full path where it has a fixed one. On Windows
 * a bare program name is looked up in the current directory before PATH,
 * so a `rundll32.exe` sitting in the directory `engram upgrade` was run
 * from would be the program that ran.
 */
export function openUrlCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
  systemRoot: string = process.env.SystemRoot || "C:\\Windows",
): { file: string; args: string[] } | null {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return null;
  }
  if (protocol !== "https:" && protocol !== "http:") return null;
  if (platform === "darwin") return { file: "/usr/bin/open", args: [url] };
  if (platform === "win32") {
    return {
      file: win32.join(systemRoot, "System32", "rundll32.exe"),
      args: ["url.dll,FileProtocolHandler", url],
    };
  }
  return { file: "xdg-open", args: [url] };
}

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

  const res = await fetch(`${resolveBaseUrl(config)}/api/billing/checkout`, {
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

  // Try to open in browser. A missing opener (xdg-open on a headless box)
  // arrives as an 'error' event, which must not crash the CLI: the URL is
  // already printed above.
  const opener = openUrlCommand(data.url);
  try {
    if (!opener) throw new Error("not a web URL");
    const child = spawn(opener.file, opener.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
    console.log(dim("  Opening in your browser..."));
  } catch {
    console.log(dim("  Open the URL above to complete checkout."));
  }
}
