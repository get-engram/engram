#!/usr/bin/env node

import { createRequire } from "node:module";
import { Engram } from "@getengram/sdk";
import { resolveBaseUrl } from "./config.js";
import { configProblem, loadConfigForUse } from "./config-guard.js";
import { authLogin, authLogout, authStatus } from "./commands/auth.js";
import { signup, login, link, whoami } from "./commands/login.js";
import {
  listConversations,
  createConversation,
  getConversation,
  deleteConversation,
} from "./commands/conversations.js";
import { store } from "./commands/store.js";
import { search } from "./commands/search.js";
import { log as showLog } from "./commands/log.js";
import { importHistory } from "./commands/import.js";
import { daemonStart, daemonStop, daemonStatus, daemonInstall, daemonUninstall } from "./daemon/index.js";
import { autoEnableCapture } from "./daemon/commands.js";
import { upgrade } from "./commands/upgrade.js";
import { usage as showUsage } from "./commands/usage.js";
import { status as showStatus } from "./commands/status.js";
import { vaultKeygen, vaultSaveKey, vaultStatus, vaultSet, vaultGet, vaultList, vaultDelete } from "./commands/vault.js";
import { readVaultKey, vaultKeyFileState, vaultKeyFix, VaultKeyUnreadable } from "./vault-key.js";
import { excludeAdd, excludeRemove, excludeList } from "./commands/exclude.js";
import { bold, dim, red } from "./output.js";
import { readStatus, syncErrorSummary, captureErrorSummary, configProblemSummary } from "./daemon/status.js";
import {
  foreignFiles,
  foreignFilesFix,
  foreignFilesProblem,
  lockedDir,
  lockedDirFix,
  lockedDirProblem,
  type LockedDir,
} from "./daemon/ownership.js";
import { findRootDaemon, rootDaemonLines } from "./daemon/root-daemon.js";
import { asRootRefusal, rootForAnotherUser } from "./daemon/as-root.js";
import { engramCommand } from "./daemon/package-runner.js";
import { alive, pidInFile } from "./daemon/instance.js";

// Read from package.json rather than duplicated here. The previous hardcoded
// constant had drifted to 0.3.4 while the package shipped 0.5.1, so
// `engram version` — the first thing anyone reports in a bug — was wrong for
// two releases. npm always includes package.json in the tarball, and dist/
// sits directly under the package root, so this resolves both from the repo
// and from a global install.
const VERSION: string = (() => {
  try {
    const require = createRequire(import.meta.url);
    return (require("../package.json") as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

// Commands that take 1 word
const TOP_COMMANDS = new Set([
  "help", "version", "store", "append", "search", "find", "convs",
  "start", "stop", "status", "install", "uninstall", "log",
  "signup", "login", "link", "whoami", "upgrade", "import",
]);
// Commands that take 2 words (group + subcommand)
const GROUP_COMMANDS = new Set(["auth", "conversations", "conv", "daemon", "vault", "exclude"]);

function parseArgs(argv: string[]): {
  command: string[];
  args: string[];
  flags: Record<string, string>;
} {
  const command: string[] = [];
  const args: string[] = [];
  const flags: Record<string, string> = {};

  let i = 0;

  // Collect command: 1 word for top commands, up to 2 for groups
  if (i < argv.length && !argv[i].startsWith("-")) {
    command.push(argv[i]);
    i++;

    // If it's a group command, take one more non-flag token as subcommand
    if (
      GROUP_COMMANDS.has(command[0]) &&
      i < argv.length &&
      !argv[i].startsWith("-")
    ) {
      command.push(argv[i]);
      i++;
    }
  }

  // Parse remaining as args and flags
  while (i < argv.length) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = "";
        i++;
      }
    } else if (token.startsWith("-") && token.length === 2) {
      const key = token.slice(1);
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = "";
        i++;
      }
    } else {
      args.push(token);
      i++;
    }
  }

  return { command, args, flags };
}

/**
 * `vault`: the command uses the vault key, to encrypt the secrets in what
 * it sends or for the vault itself. One that can't be read stops it before
 * anything is sent, rather than send without it (engram#677). The other
 * commands don't read the key.
 */
async function getClient(options: { vault?: boolean } = {}): Promise<Engram> {
  // Strict (engram#673): a config.json that can't be read isn't "not
  // authenticated", and ENGRAM_API_KEY isn't sent to the default server in
  // place of the one it names.
  const config = await loadConfigForUse();
  const apiKey = process.env.ENGRAM_API_KEY ?? config.apiKey;

  if (!apiKey) {
    console.error(
      "Not authenticated. Run:\n\n" +
        `  ${engramCommand("signup")}     # create a free account\n` +
        `  ${engramCommand("login")}      # sign in with email + password\n`,
    );
    process.exit(1);
  }

  let vaultKey: string | undefined;
  if (options.vault) {
    try {
      vaultKey = await readVaultKey();
    } catch (err: unknown) {
      if (!(err instanceof VaultKeyUnreadable)) throw err;
      console.error(red(`Error: ${err.message}, so Engram can't use your vault key. Nothing was sent.`));
      console.error(dim(`  ${vaultKeyFix(err)}`));
      console.error(dim("  Then run this again."));
      process.exit(1);
    }
  }

  return new Engram({
    apiKey,
    baseUrl: resolveBaseUrl(config),
    vault: vaultKey ? { encryptionKey: vaultKey } : undefined,
  });
}

function printHelp(): void {
  console.log(`
${bold("engram")} — persistent memory for AI agents

${bold("USAGE")}
  engram <command> [options]

${bold("COMMANDS")}
  ${bold("signup")}                   Create a free account instantly
  ${bold("login")}                    Sign in with email + password
  ${bold("link")}                     Link email to your account for dashboard access
  ${bold("whoami")}                   Show which account this machine is using

  All auth commands accept ${dim("--email")} and ${dim("--password")} flags for non-interactive (agent) usage.

  ${bold("auth login")} <key>         Authenticate with API key ${dim("(manual)")}
  ${bold("auth logout")}              Remove stored credentials
  ${bold("auth status")}              Show authentication status

  ${bold("conversations list")}       List conversations
  ${bold("conversations create")}     Create a new conversation
  ${bold("conversations get")} <id>   Get conversation with messages
  ${bold("conversations delete")} <id> Delete a conversation

  ${bold("store")} -c <id> <message>  Store a message
  ${bold("search")} <query>           Semantic search across memory
  ${bold("import")} <file.json>       Import a ChatGPT or Claude data export
  ${bold("log")}                      Show recent AI conversation activity
  ${bold("upgrade")} [pro|team]       Upgrade your plan (opens Stripe checkout)
  ${bold("usage")}                    Show memory storage and monthly usage meters

  ${bold("vault keygen")}             Generate a new vault encryption key
  ${bold("vault keygen --save")}      Generate and save key to ~/.engram/vault-key
  ${bold("vault save-key")}           Save ENGRAM_VAULT_KEY to ~/.engram/vault-key ${dim("(for the daemon at login)")}
  ${bold("vault status")}             Show vault configuration status
  ${bold("vault set")} <name> [value] Store a named secret ${dim("(encrypted client-side)")}
  ${bold("vault get")} <name>         Retrieve a named secret ${dim("(decrypted locally)")}
  ${bold("vault list")}               List secret names ${dim("(never shows values)")}
  ${bold("vault list --check")}       Also say which don't decrypt with your vault key
  ${bold("vault delete")} <name>      Delete a named secret permanently

  ${bold("exclude add")} [path]       Never capture sessions in a directory ${dim("(default: cwd)")}
  ${bold("exclude remove")} [path]    Re-enable capture for a directory
  ${bold("exclude list")}             Show excluded paths
  ${dim("Also: a .engramignore file at a repo root excludes that repo (committable),")}
  ${dim('and saying "don\'t save this to engram" in a session excludes + erases it.')}

  ${bold("start")}                    Start background daemon (auto-capture)
  ${bold("stop")}                     Stop the daemon
  ${bold("status")}                   Show daemon status, sync info, and plan usage
  ${bold("install")}                  Start the daemon at login ${dim("(macOS, Windows, Linux with systemd)")}
  ${bold("uninstall")}                Turn off start at login

  ${bold("version")}                  Show version
  ${bold("help")}                     Show this help

${bold("OPTIONS")}
  --json          Output as JSON
  --limit <n>     Limit results
  --offset <n>    Skip the first n results (paging)
  --tags <a,b>    Filter by tags
  --agent <id>    Filter by agent ID

${bold("EXAMPLES")}
  engram signup
  engram login
  engram conversations create --title "My Chat" --tags dev,test
  engram store -c conv_abc "deployed v2.1 to production"
  engram search "when did we deploy"

${bold("ENVIRONMENT")}
  ENGRAM_API_KEY      API key ${dim("(overrides auth login)")}
  ENGRAM_BASE_URL     Custom endpoint ${dim("(default: https://mcp.getengram.app)")}
  ENGRAM_VAULT_KEY    Vault encryption key ${dim("(enables client-side secret encryption)")}

${dim(`v${VERSION} — https://getengram.app`)}
`);
}

/**
 * Print a one-time banner if the background sync daemon is stuck in a state
 * the user has to resolve. Goes to stderr, never stdout, so `--json` output
 * stays machine-parseable.
 *
 * Only the states a human must act on are surfaced: transcripts that can't
 * be queued on this machine (a full disk, engram#584), a rejected key, a
 * full memory, a vault key that can't be read (engram#677), or that
 * decrypts none of the vault's secrets (engram#694). Transient
 * trouble (network, rate limits, 5xx) resolves itself and would just be
 * noise on every command.
 */
async function printSyncBanner(): Promise<void> {
  try {
    const s = readStatus();
    // Waiting on config.json (engram#673): printConfigBanner says why, from
    // the file itself. Once it reads fine, the daemon picks up on its own.
    if (s.capture_error && s.capture_error.kind !== "config") {
      console.error(red(bold("engram:")) + ` ${captureErrorSummary(s.capture_error)}`);
      console.error(dim(`  (run '${engramCommand("status")}' for details)`));
      console.error("");
    }
    if (
      s.error_type !== "storage_full" &&
      s.error_type !== "auth" &&
      s.error_type !== "vault_key" &&
      s.error_type !== "vault_mismatch"
    ) {
      return;
    }
    if (s.error_type === "vault_mismatch") {
      // A key file that reads proves nothing here: it is the key that
      // doesn't match (engram#694). One that is gone, with no daemon
      // running: the next starts without a key, and sends what was held.
      const key = await vaultKeyFileState();
      if (key === "none" && !daemonRuns()) return;
    }
    if (s.error_type === "vault_key") {
      // A vault key that reads fine now: the daemon reads it again within a
      // minute, and sends what it held. One that is gone holds them only in
      // the daemon that held them: the next starts without a key, and sends
      // them. So with no daemon running, as after 'engram stop' (how to go
      // on without a key), there is nothing to say. One that is another
      // user's is said with the files that are (engram#695), whose fix
      // this doesn't give: by the banner after this one, or by start and
      // install themselves.
      const key = await vaultKeyFileState();
      if (key === "key" || (key === "none" && !daemonRuns()) || foreignKeyHolds()) return;
    }
    const queued =
      s.pending_messages > 0
        ? ` ${s.pending_messages.toLocaleString("en-US")} message${s.pending_messages === 1 ? "" : "s"} waiting locally.`
        : "";
    console.error(red(bold("engram:")) + ` ${syncErrorSummary(s.error_type, s.storage)}${queued}`);
    console.error(dim(`  (run '${engramCommand("status")}' for details)`));
    console.error("");
  } catch {
    // Never let a status-file problem block the command the user asked for.
  }
}

/** Another user's vault key holds sends (engram#695). */
function foreignKeyHolds(): boolean {
  try {
    return foreignFiles()?.holdsSends === true;
  } catch {
    return false;
  }
}

/**
 * Whether a process runs with the PID in daemon.pid. Only to choose what to
 * say: a PID that another process has since been given makes it say what
 * the daemon would.
 */
function daemonRuns(): boolean {
  const pid = pidInFile();
  return pid !== null && alive(pid);
}

/**
 * Files in ~/.engram that are another user's (engram#659), from `sudo
 * engram …`. Looked for here, before every command, rather than recorded
 * in status.json with capture_error: the daemon that would record it is
 * what they stop, status.json may be one of them, and a record would
 * outlast the fix. Once they are the user's, the capture check after the
 * next command starts the daemon again.
 */
function printForeignFilesBanner(commandSaysRoot: boolean): void {
  try {
    const foreign = foreignFiles();
    if (!foreign) return;
    // The daemon that made them may still run as root (engram#680), and
    // makes more until it is stopped: that comes first. `engram stop` says
    // both itself, as it can't stop that daemon.
    const root = foreign.root ? findRootDaemon() : null;
    if (root && commandSaysRoot) return;
    if (root) {
      const { problem, fixes } = rootDaemonLines(root);
      console.error(red(bold("engram:")) + ` ${problem}`);
      for (const fix of fixes) console.error(dim(`  ${fix}`));
    }
    console.error(red(bold("engram:")) + ` ${foreignFilesProblem(foreign)}`);
    console.error(dim(`  ${foreignFilesFix(foreign, root !== null)}`));
    console.error("");
  } catch {
    // Never let this block the command the user asked for.
  }
}

/**
 * A ~/.engram its own permissions keep the user out of (engram#723), as
 * `chmod -R 600 ~/.engram` leaves it, or null. Every file in it is still
 * theirs and whole, and what fails is each one opened, so what was said
 * was about a file: that config.json can't be read, a chmod of the vault
 * key that can't reach it. Looked at before every command, as the files
 * that are another user's are. Never throws.
 */
function findLockedDir(): LockedDir | null {
  try {
    return lockedDir();
  } catch {
    return null;
  }
}

function printLockedDirBanner(locked: LockedDir): void {
  console.error(red(bold("engram:")) + ` ${lockedDirProblem(locked)}`);
  console.error(dim(`  ${lockedDirFix(locked)}`));
  console.error("");
}

/**
 * A ~/.engram/config.json that can't be read (engram#673): capture waits on
 * it, and commands that use or save settings stop. Read from the file here,
 * before every command, rather than from status.json: the daemon may not
 * be running, and a record would outlast the fix.
 */
async function printConfigBanner(): Promise<void> {
  const problem = await configProblem();
  if (!problem) return;
  console.error(red(bold("engram:")) + ` ${configProblemSummary(problem.message)}`);
  console.error(dim(`  (run '${engramCommand("status")}' for details)`));
  console.error("");
}

async function main(): Promise<void> {
  const raw = process.argv.slice(2);

  if (raw.length === 0) {
    printHelp();
    return;
  }

  // Handle top-level flags before parsing
  if (raw.length === 1 && (raw[0] === "--help" || raw[0] === "-h")) {
    printHelp();
    return;
  }
  if (raw.length === 1 && (raw[0] === "--version" || raw[0] === "-v")) {
    console.log(`engram ${VERSION}`);
    return;
  }

  const { command, args, flags } = parseArgs(raw);
  const cmd = command.join(" ");

  // Run as root for the user, as with sudo, only help and version run, and
  // they print only themselves: nothing in ~/.engram is read or written
  // (engram#682). Another command would save what it writes as root's, in
  // the user's ~/.engram on macOS, where sudo keeps HOME, or set Engram up
  // for root on Linux.
  if (rootForAnotherUser()) {
    if (cmd === "help") printHelp();
    else if (cmd === "version") console.log(`engram ${VERSION}`);
    else {
      const { problem, fix } = asRootRefusal(cmd);
      console.error(red(problem));
      console.error(dim(fix));
      process.exitCode = 1;
    }
    return;
  }

  // Capture is the product default: any authenticated interactive use of
  // the CLI ensures the daemon is running (unless the user explicitly ran
  // stop/uninstall — autoEnableCapture respects config.autocapture="off").
  // Runs after the command so its output never interleaves, and says
  // something only when it had to start the daemon or turn on start at
  // login (engram#644); skipped for daemon-management and auth commands,
  // which handle capture themselves.
  const CAPTURE_EXEMPT = new Set([
    "help", "version", "start", "stop", "restart", "install", "uninstall",
    "status", "log", "signup", "login", "link", "auth login", "auth logout",
    // The `daemon` spellings of the same commands (engram#609).
    "daemon start", "daemon stop", "daemon status", "daemon install", "daemon uninstall",
    // A user configuring exclusions is expressing a privacy preference —
    // that must never silently resurrect the capture daemon (engram#462).
    "exclude", "exclude add", "exclude remove", "exclude rm", "exclude list", "exclude ls",
  ]);
  const ensureCaptureAfter = !CAPTURE_EXEMPT.has(cmd);

  // The daemon is headless, so a full memory would otherwise only ever be
  // visible in ~/.engram/daemon.log. Surface it on the next interactive
  // command instead — this is the moment the user is actually looking.
  // The status commands and `usage` print their own detail, so skip the
  // banner there.
  // These say it themselves: the status commands, and those that save
  // settings, which refuse to save over the file, or save an empty one and
  // say what that means (engram#673).
  const SAYS_CONFIG_PROBLEM = new Set([
    "status", "daemon status", "signup", "login", "auth login", "auth logout",
    "stop", "daemon stop", "uninstall", "daemon uninstall",
    "exclude", "exclude add", "exclude remove", "exclude rm", "exclude list", "exclude ls",
  ]);
  // A ~/.engram the user is kept out of (engram#723): start, install and
  // status say it themselves, and, with config.json in it out of reach,
  // so do the commands that read or save it, saying why they can't. The
  // banner for config.json would say what is wrong with the file, and
  // nothing is.
  const locked = findLockedDir();
  const SAYS_LOCKED_DIR = new Set(["start", "daemon start", "install", "daemon install", "status", "daemon status"]);
  if (locked && !SAYS_LOCKED_DIR.has(cmd) && !(locked.search && SAYS_CONFIG_PROBLEM.has(cmd))) {
    printLockedDirBanner(locked);
  }
  if (!SAYS_CONFIG_PROBLEM.has(cmd) && !locked?.search) await printConfigBanner();
  if (cmd !== "status" && cmd !== "daemon status" && cmd !== "usage") {
    await printSyncBanner();
  }
  // start, install and status say it themselves. So does stop, with a
  // daemon running as root that made them (engram#680).
  const SAYS_FOREIGN_FILES = new Set(["start", "daemon start", "install", "daemon install", "status", "daemon status"]);
  const SAYS_ROOT_DAEMON = new Set(["stop", "daemon stop"]);
  if (!SAYS_FOREIGN_FILES.has(cmd)) printForeignFilesBanner(SAYS_ROOT_DAEMON.has(cmd));

  try {
    switch (cmd) {
      case "help":
        printHelp();
        break;

      case "version":
        console.log(`engram ${VERSION}`);
        break;

      case "signup":
        await signup();
        break;

      case "login":
        await login(args, flags);
        break;

      case "link":
        await link(args, flags);
        break;

      case "whoami":
      case "auth whoami":
        await whoami();
        break;

      case "auth login":
        await authLogin(args);
        break;

      case "auth logout":
        await authLogout();
        break;

      case "auth status":
      case "auth":
        await authStatus();
        break;

      case "conversations list":
      case "conversations ls":
      case "convs":
        await listConversations(await getClient(), args, flags);
        break;

      case "conversations create":
      case "conversations new":
        await createConversation(await getClient(), args, flags);
        break;

      case "conversations get":
      case "conversations show":
        await getConversation(await getClient(), args, flags);
        break;

      case "conversations delete":
      case "conversations rm":
        await deleteConversation(await getClient(), args, flags);
        break;

      case "store":
      case "append":
        await store(await getClient({ vault: true }), args, flags);
        break;

      case "search":
      case "find":
        await search(await getClient(), args, flags);
        break;

      case "log":
        await showLog(await getClient(), args, flags);
        break;

      case "import":
        await importHistory(await getClient({ vault: true }), args, flags);
        break;

      case "upgrade":
        await upgrade(args, flags);
        break;

      case "usage":
        await showUsage(args, flags);
        break;

      // The daemon on this machine, then the account's plan and usage
      // (engram#609). `engram daemon status` shows the daemon alone.
      case "status":
        await showStatus(args, flags);
        break;

      // Vault commands
      case "vault keygen":
        await vaultKeygen(args, flags);
        break;

      case "vault save-key":
        await vaultSaveKey(flags);
        break;

      case "vault set":
        await vaultSet(await getClient({ vault: true }), args, flags);
        break;

      case "vault get":
        await vaultGet(await getClient({ vault: true }), args, flags);
        break;

      case "vault list":
      case "vault ls":
        await vaultList(await getClient({ vault: true }), args, flags);
        break;

      case "vault delete":
      case "vault rm":
        await vaultDelete(await getClient({ vault: true }), args, flags);
        break;

      case "vault status":
      case "vault":
        await vaultStatus();
        break;

      // Capture exclusions (engram#462)
      case "exclude add":
        await excludeAdd(args);
        break;

      case "exclude remove":
      case "exclude rm":
        await excludeRemove(args);
        break;

      case "exclude list":
      case "exclude ls":
      case "exclude":
        await excludeList();
        break;

      // Daemon commands — short aliases + namespaced
      case "start":
      case "daemon start":
        await daemonStart(args, flags);
        break;

      case "stop":
      case "daemon stop":
        await daemonStop();
        break;

      case "daemon status":
        await daemonStatus();
        break;

      case "install":
      case "daemon install":
        await daemonInstall();
        break;

      case "uninstall":
      case "daemon uninstall":
        await daemonUninstall();
        break;

      default:
        // Check if first word is a known command group
        if (command[0] === "conversations" || command[0] === "conv") {
          console.error(`Unknown subcommand: ${command.slice(1).join(" ")}`);
          console.error("Available: list, create, get, delete");
        } else {
          console.error(`Unknown command: ${cmd}`);
          console.error(`Run '${engramCommand("help")}' for usage.`);
        }
        process.exit(1);
    }
  } catch (err: unknown) {
    if (err instanceof Error) {
      console.error(`Error: ${err.message}`);
    } else {
      console.error("An unexpected error occurred");
    }
    process.exit(1);
  }

  if (ensureCaptureAfter) {
    await autoEnableCapture({ after: "command" });
  }
}

main();
