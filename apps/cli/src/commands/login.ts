import { createInterface } from "node:readline";
import { saveConfig, loadConfig, getBaseUrl } from "../config.js";
import { green, red, dim, bold } from "../output.js";
import { Engram } from "@getengram/sdk";
import { autoEnableCapture } from "../daemon/commands.js";

const API_URL = process.env.ENGRAM_BASE_URL ?? getBaseUrl();

/** Prompt for input (hides input for passwords). */
function prompt(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    if (hidden && process.stdin.isTTY) {
      // Mute output for password entry
      process.stdout.write(question);
      const stdin = process.stdin;
      const wasRaw = stdin.isRaw;
      stdin.setRawMode(true);
      let input = "";
      const onData = (ch: Buffer) => {
        const c = ch.toString();
        if (c === "\n" || c === "\r") {
          stdin.setRawMode(wasRaw ?? false);
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          rl.close();
          resolve(input);
        } else if (c === "\x03") {
          // Ctrl+C
          process.exit(1);
        } else if (c === "\x7f" || c === "\b") {
          // Backspace
          input = input.slice(0, -1);
        } else {
          input += c;
        }
      };
      stdin.on("data", onData);
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

/**
 * `engram signup` — create an anonymous account instantly.
 * No email, no password. Just get a key and start using Engram.
 */
export async function signup(): Promise<void> {
  const existing = await loadConfig();
  if (existing.apiKey) {
    console.error(
      "You already have an account. Your API key is saved in ~/.engram/config.json\n\n" +
        "  engram auth status    # check your account\n" +
        "  engram auth logout    # remove credentials before creating a new account\n",
    );
    process.exit(1);
  }

  console.log("Creating account...");

  const res = await fetch(`${API_URL}/signup/anonymous`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(red(`Signup failed: ${res.status} ${body}`));
    process.exit(1);
  }

  const data = (await res.json()) as {
    organization_id: string;
    api_key: string;
  };

  const config = await loadConfig();
  config.apiKey = data.api_key;
  await saveConfig(config);

  console.log(green("✓ Account created"));
  console.log(`  Organization: ${data.organization_id}`);
  console.log(`  API key saved to ~/.engram/config.json`);
  await autoEnableCapture();
  console.log(
    dim("  Tip: run 'engram link <email>' to claim your account for upgrades"),
  );
}

/**
 * `engram link` — attach an email + password to an anonymous account.
 * Creates a Supabase user and links it to the existing org.
 */
export async function link(args: string[] = [], flags: Record<string, string> = {}): Promise<void> {
  const config = await loadConfig();
  const apiKey = process.env.ENGRAM_API_KEY ?? config.apiKey;

  if (!apiKey) {
    console.error(red("Not authenticated. Run 'engram signup' first."));
    process.exit(1);
  }

  const email = flags.email || await prompt("Email: ");

  if (!email) {
    console.error(red("Email is required."));
    process.exit(1);
  }

  console.log("Linking account...");

  // Link email to org via worker. Supabase user creation happens
  // lazily on first dashboard login — the CLI only needs the email
  // attached to the org for billing.
  const linkRes = await fetch(`${API_URL}/signup/link`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ email: email.trim() }),
  });

  if (!linkRes.ok) {
    const err = (await linkRes.json().catch(() => ({}))) as { error?: string; message?: string };
    if (err.error === "email_taken") {
      console.error(
        red(`An account already exists for ${email.trim()}.\n`) +
          "\n  If that's your account, sign in instead:\n" +
          `    engram login --email ${email.trim()} --password <your-password>\n`,
      );
    } else {
      console.error(red(err.message || `Link failed: ${linkRes.status}`));
    }
    process.exit(1);
  }

  console.log(green(`✓ Account linked to ${email.trim()}`));

  // Offer a web password so getengram.app/login works with more than the
  // API key. --password makes it non-interactive for agents.
  let password = flags.password || "";
  if (!password && process.stdin.isTTY) {
    const answer = await prompt("Create a password for web login? [y/N] ");
    if (/^y(es)?$/i.test(answer.trim())) {
      password = await prompt("Password (min 8 chars): ", true);
    }
  }
  if (password) {
    await setWebPassword(apiKey, password);
  } else {
    console.log(`  You can sign in at getengram.app/login with your API key`);
  }
}

/** POST /signup/set-password — create the Supabase login for this org. */
async function setWebPassword(apiKey: string, password: string): Promise<void> {
  const res = await fetch(`${API_URL}/signup/set-password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ password }),
  });
  const j = (await res.json().catch(() => ({}))) as {
    error?: string;
    message?: string;
    confirmation_required?: boolean;
    email?: string;
  };
  if (!res.ok) {
    console.error(red(j.message || `Failed to set password (${res.status})`));
    return; // non-fatal: the link itself succeeded
  }
  console.log(green("✓ Password set"));
  if (j.confirmation_required) {
    console.log(`  Check ${j.email} for a confirmation link, then sign in at getengram.app/login`);
  } else {
    console.log(`  Sign in at getengram.app/login`);
  }
}

/**
 * `engram whoami` — which account is this machine using?
 * Shows the org, email (or anonymous), and tier for the active API key.
 */
export async function whoami(): Promise<void> {
  const config = await loadConfig();
  const apiKey = process.env.ENGRAM_API_KEY ?? config.apiKey;
  if (!apiKey) {
    console.log("Not authenticated.");
    console.log("\nRun: engram login   (or engram auth login <api-key>)");
    process.exit(1);
  }

  const res = await fetch(`${API_URL}/api/account`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    console.error(red(`Could not fetch account (${res.status}). Check your API key.`));
    process.exit(1);
  }
  const acct = (await res.json()) as {
    org_id: string;
    email: string | null;
    name: string | null;
    tier: string;
  };
  const source = process.env.ENGRAM_API_KEY ? "ENGRAM_API_KEY env var" : "~/.engram/config.json";

  console.log(`${bold(acct.name ?? acct.org_id)} ${dim(`(${acct.tier})`)}`);
  if (acct.email) {
    console.log(`  Email: ${acct.email}`);
  } else {
    console.log(`  Email: ${dim("none — anonymous account")}`);
    console.log(dim("  Add one (enables web login + billing): engram link <email>"));
  }
  console.log(`  Org:   ${acct.org_id}`);
  console.log(`  Key:   ${apiKey.slice(0, 20)}... ${dim(`(${source})`)}`);
}

/**
 * `engram login` — sign in with email + password.
 * Calls Supabase auth, then the worker /signup to get an API key.
 */
export async function login(args: string[] = [], flags: Record<string, string> = {}): Promise<void> {
  const email = flags.email || await prompt("Email: ");
  const password = flags.password || await prompt("Password: ", true);

  if (!email || !password) {
    console.error(red("Email and password are required."));
    process.exit(1);
  }

  console.log("Signing in...");

  // Authenticate via worker — keeps Supabase credentials server-side
  const signupRes = await fetch(`${API_URL}/signup/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: email.trim(), password }),
  });

  if (signupRes.status === 409) {
    // Account already has a key — check if we have one locally
    const config = await loadConfig();
    if (config.apiKey) {
      console.log(green(`✓ Signed in as ${email.trim()}`));
      console.log(`  Using existing API key from ~/.engram/config.json`);
      await autoEnableCapture();
      return;
    }
    console.error(
      red("Your account already has an API key.\n") +
        "  Use 'engram auth login <key>' to set it, or manage keys at getengram.app/dashboard",
    );
    process.exit(1);
  }

  if (!signupRes.ok) {
    const err = (await signupRes.json().catch(() => ({}))) as { message?: string };
    console.error(red(err.message || `Login failed: ${signupRes.status}`));
    process.exit(1);
  }

  const data = (await signupRes.json()) as {
    organization_id: string;
    api_key: string;
  };

  const config = await loadConfig();
  config.apiKey = data.api_key;
  await saveConfig(config);

  console.log(green(`✓ Signed in as ${email.trim()}`));
  console.log(`  API key saved to ~/.engram/config.json`);
  await autoEnableCapture();
}
