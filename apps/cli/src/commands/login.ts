import { createInterface } from "node:readline";
import { loadConfigStrict, resolveBaseUrl, type Config } from "../config.js";
import { ConfigUnreadable } from "../config-file.js";
import { loadConfigForUpdate, loadConfigForUse, requireWritableConfig, saveConfigOrExit } from "../config-guard.js";
import { green, red, dim, bold } from "../output.js";
import { Engram } from "@getengram/sdk";
import { autoEnableCapture } from "../daemon/commands.js";

/**
 * The server these commands talk to: see resolveBaseUrl (engram#625). Read
 * strictly (engram#673): from a config.json that couldn't be read, it was
 * the default server whatever the file named, and the key went there.
 */
const apiUrl = async (): Promise<string> => resolveBaseUrl(await loadConfigForUse());

/**
 * Save `key`, just made for this machine, into config.json with what else
 * is in it. Read again, as it may have changed while the server answered,
 * and not saved over when it can't be read now (engram#673). `command`:
 * the one to run again once it's fixed. `lost`: what a save that fails
 * means, said with why it failed (engram#717). It was checked before the
 * key was made, but a disk can fill up in between.
 */
async function saveNewKey(key: string, command: string, lost: string[]): Promise<void> {
  let config: Config;
  try {
    config = await loadConfigStrict();
  } catch (err: unknown) {
    if (!(err instanceof ConfigUnreadable && err.empty)) {
      const why = err instanceof ConfigUnreadable ? err.message : "~/.engram/config.json can't be read";
      console.error(red(`Error: ${why}, so the new API key wasn't saved.`));
      console.error(`  Fix the file, then run 'engram ${command}' again.`);
      process.exit(1);
    }
    // Empty: said by loadConfigForUpdate, before the key was made.
    config = {};
  }
  config.apiKey = key;
  await saveConfigOrExit(config, lost, command);
}

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
  // Before an account is made (engram#673): read leniently, a file that
  // couldn't be read had no key in it, so a second account was made, and
  // its key saved over the file, the first one's key and the folders
  // excluded from capture with it.
  const existing = await loadConfigForUpdate();
  if (existing.apiKey) {
    console.error(
      "You already have an account. Your API key is saved in ~/.engram/config.json\n\n" +
        "  engram auth status    # check your account\n" +
        "  engram auth logout    # remove credentials before creating a new account\n",
    );
    process.exit(1);
  }

  // Before the account is made (engram#717): its key is saved in
  // config.json, and a key that couldn't be saved left an account no one
  // could use. Each try made another.
  requireWritableConfig(["A new account's API key is saved there, so no account was made."], "signup");

  console.log("Creating account...");

  const res = await fetch(`${resolveBaseUrl(existing)}/signup/anonymous`, {
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

  await saveNewKey(data.api_key, "signup", [
    "An account was made, but its API key couldn't be saved, so it can't be used.",
  ]);

  console.log(green("✓ Account created"));
  console.log(`  Organization: ${data.organization_id}`);
  console.log(`  API key saved to ~/.engram/config.json`);
  await autoEnableCapture({ after: "login" });
  console.log(
    dim("  Tip: run 'engram link <email>' to claim your account for upgrades"),
  );
}

/**
 * `engram link` — attach an email + password to an anonymous account.
 * Creates a Supabase user and links it to the existing org.
 */
export async function link(args: string[] = [], flags: Record<string, string> = {}): Promise<void> {
  const config = await loadConfigForUse();
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
  const linkRes = await fetch(`${await apiUrl()}/signup/link`, {
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
  const res = await fetch(`${await apiUrl()}/signup/set-password`, {
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
  const config = await loadConfigForUse();
  const apiKey = process.env.ENGRAM_API_KEY ?? config.apiKey;
  if (!apiKey) {
    console.log("Not authenticated.");
    console.log("\nRun: engram login   (or engram auth login <api-key>)");
    process.exit(1);
  }

  const res = await fetch(`${await apiUrl()}/api/account`, {
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
 * Exit, without touching config.json, unless the saved API key belongs to
 * the account `email` signed in to (engram#594). The server's 409 names
 * that account's id, and GET /api/account names the key's; only when the
 * 409 carries no id do the emails decide, compared without regard to case.
 */
async function confirmSavedKeyIsFor(
  email: string,
  orgId: string | null,
  apiKey: string,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${await apiUrl()}/api/account`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err: unknown) {
    console.error(
      red(`Couldn't check which account the saved API key belongs to (${err instanceof Error ? err.message : String(err)}).\n`) +
        "  Nothing was changed. Run 'engram whoami' to see the account in use.",
    );
    process.exit(1);
  }
  if (res.status === 401) {
    console.error(
      red("The API key saved in ~/.engram/config.json was rejected.\n") +
        "  Get a key for this account at getengram.app/dashboard, then run 'engram auth login <key>'.",
    );
    process.exit(1);
  }
  if (!res.ok) {
    console.error(
      red(`Couldn't check which account the saved API key belongs to (HTTP ${res.status}).\n`) +
        "  Nothing was changed. Run 'engram whoami' to see the account in use.",
    );
    process.exit(1);
  }
  const acct = (await res.json().catch(() => ({}))) as { org_id?: unknown; email?: unknown };
  const saved = typeof acct.email === "string" ? acct.email : null;
  const same =
    orgId !== null
      ? acct.org_id === orgId
      : saved !== null && saved.trim().toLowerCase() === email.toLowerCase();
  if (same) return;
  console.error(
    red(
      `The API key saved in ~/.engram/config.json belongs to ` +
        `${saved ? `another account (${saved})` : "another account (one with no email)"}, not ${email}.\n`,
    ) +
      "  Nothing was changed, and capture still goes to that account.\n" +
      `  To switch: get a key for ${email} at getengram.app/dashboard, then run 'engram auth login <key>'.`,
  );
  process.exit(1);
}

/**
 * `engram login` — sign in with email + password.
 * Calls Supabase auth, then the worker /signup to get an API key.
 */
export async function login(args: string[] = [], flags: Record<string, string> = {}): Promise<void> {
  // Before the password is asked for (engram#673). Read leniently, a file
  // that couldn't be read named no server, so the password went to the
  // default one, and the key it got was saved over the file.
  const existing = await loadConfigForUpdate();
  // Before the password is asked for (engram#717): signing in makes a new
  // API key, saved in config.json. One that couldn't be saved stayed in the
  // account, unused, and each try made another.
  requireWritableConfig(["Signing in saves a new API key there, so it wasn't tried."], "login");
  const email = flags.email || await prompt("Email: ");
  const password = flags.password || await prompt("Password: ", true);

  if (!email || !password) {
    console.error(red("Email and password are required."));
    process.exit(1);
  }

  console.log("Signing in...");

  // Authenticate via worker — keeps Supabase credentials server-side
  const signupRes = await fetch(`${resolveBaseUrl(existing)}/signup/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: email.trim(), password }),
  });

  if (signupRes.status === 409) {
    // Account already has a key — check if we have one locally. It has to
    // be THIS account's: this used to say "signed in" whatever account the
    // saved key belonged to, and capture went on into that one (engram#594).
    const conflict = (await signupRes.json().catch(() => ({}))) as { organization_id?: unknown };
    const orgId = typeof conflict.organization_id === "string" ? conflict.organization_id : null;
    const config = await loadConfigForUse();
    if (config.apiKey) {
      await confirmSavedKeyIsFor(email.trim(), orgId, config.apiKey);
      console.log(green(`✓ Signed in as ${email.trim()}`));
      console.log(`  Using existing API key from ~/.engram/config.json`);
      await autoEnableCapture({ after: "login" });
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

  await saveNewKey(data.api_key, "login", [
    "A new API key was made for this machine, but it couldn't be saved.",
    "It's listed at getengram.app/dashboard as \"CLI login\": delete it there.",
  ]);

  console.log(green(`✓ Signed in as ${email.trim()}`));
  console.log(`  API key saved to ~/.engram/config.json`);
  await autoEnableCapture({ after: "login" });
}
