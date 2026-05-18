#!/usr/bin/env node

import { Engram } from "@getengram/sdk";
import { loadConfig, getBaseUrl } from "./config.js";
import { authLogin, authLogout, authStatus } from "./commands/auth.js";
import { signup, login, link } from "./commands/login.js";
import {
  listConversations,
  createConversation,
  getConversation,
  deleteConversation,
} from "./commands/conversations.js";
import { store } from "./commands/store.js";
import { search } from "./commands/search.js";
import { log as showLog } from "./commands/log.js";
import { daemonStart, daemonStop, daemonStatus, daemonInstall, daemonUninstall } from "./daemon/index.js";
import { upgrade } from "./commands/upgrade.js";
import { bold, dim } from "./output.js";

const VERSION = "0.3.1";

// Commands that take 1 word
const TOP_COMMANDS = new Set([
  "help", "version", "store", "append", "search", "find", "convs",
  "start", "stop", "status", "install", "uninstall", "log",
  "signup", "login", "link", "upgrade",
]);
// Commands that take 2 words (group + subcommand)
const GROUP_COMMANDS = new Set(["auth", "conversations", "conv", "daemon"]);

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

async function getClient(): Promise<Engram> {
  const config = await loadConfig();
  const apiKey = process.env.ENGRAM_API_KEY ?? config.apiKey;

  if (!apiKey) {
    console.error(
      "Not authenticated. Run:\n\n" +
        "  engram signup     # create a free account\n" +
        "  engram login      # sign in with email + password\n",
    );
    process.exit(1);
  }

  return new Engram({
    apiKey,
    baseUrl: process.env.ENGRAM_BASE_URL ?? config.baseUrl ?? getBaseUrl(),
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
  ${bold("log")}                      Show recent AI conversation activity
  ${bold("upgrade")} [pro|team]       Upgrade your plan (opens Stripe checkout)

  ${bold("start")}                    Start background daemon (auto-capture)
  ${bold("stop")}                     Stop the daemon
  ${bold("status")}                   Show daemon status and sync info
  ${bold("install")}                  Auto-start daemon on login (launchd)
  ${bold("uninstall")}                Remove auto-start

  ${bold("version")}                  Show version
  ${bold("help")}                     Show this help

${bold("OPTIONS")}
  --json          Output as JSON
  --limit <n>     Limit results
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

${dim(`v${VERSION} — https://getengram.app`)}
`);
}

async function main(): Promise<void> {
  const raw = process.argv.slice(2);

  if (raw.length === 0) {
    printHelp();
    return;
  }

  const { command, args, flags } = parseArgs(raw);
  const cmd = command.join(" ");

  try {
    switch (cmd) {
      case "help":
      case "--help":
      case "-h":
        printHelp();
        break;

      case "version":
      case "--version":
      case "-v":
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
        await store(await getClient(), args, flags);
        break;

      case "search":
      case "find":
        await search(await getClient(), args, flags);
        break;

      case "log":
        await showLog(await getClient(), args, flags);
        break;

      case "upgrade":
        await upgrade(args, flags);
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

      case "status":
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
          console.error("Run 'engram help' for usage.");
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
}

main();
