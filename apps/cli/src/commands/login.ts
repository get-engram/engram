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
 * `engram login` — sign in with email + password.
 * Calls Supabase auth, then the worker /signup to get an API key.
 */
export async function login(): Promise<void> {
  const email = await prompt("Email: ");
  const password = await prompt("Password: ", true);

  if (!email || !password) {
    console.error(red("Email and password are required."));
    process.exit(1);
  }

  // Sign in via Supabase REST API
  const supabaseUrl = "https://ygfqaafyfjrutxjeswks.supabase.co";
  const supabaseAnonKey =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlnZnFhYWZ5ZmpydXR4amVzd2tzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDQ1MDg3ODcsImV4cCI6MjA2MDA4NDc4N30.pK_3TgpMFsYi_4fRR-gBnLGoXxqYINOqSjjKcBqe70c";

  console.log("Signing in...");

  const authRes = await fetch(
    `${supabaseUrl}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: supabaseAnonKey,
      },
      body: JSON.stringify({ email: email.trim(), password }),
    },
  );

  if (!authRes.ok) {
    const err = (await authRes.json().catch(() => ({}))) as {
      error_description?: string;
    };
    console.error(
      red(err.error_description || `Login failed: ${authRes.status}`),
    );
    process.exit(1);
  }

  const session = (await authRes.json()) as { access_token: string };

  // Exchange Supabase token for Engram API key
  const signupRes = await fetch(`${API_URL}/signup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ plan: "free" }),
  });

  if (!signupRes.ok) {
    const body = await signupRes.text().catch(() => "");
    console.error(red(`Failed to get API key: ${signupRes.status} ${body}`));
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
