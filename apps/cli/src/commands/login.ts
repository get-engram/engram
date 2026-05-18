import { createInterface } from "node:readline";
import { saveConfig, loadConfig, getBaseUrl } from "../config.js";
import { green, red, dim } from "../output.js";
import { Engram } from "@getengram/sdk";

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
  console.log(
    dim("\n  Tip: run 'engram install' to auto-start on login"),
  );
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
  console.log(`  You can now sign in at getengram.app/login`);
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
}
