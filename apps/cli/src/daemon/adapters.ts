import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HostAdapter, OnMessages } from "./types.js";
import { Parser } from "./parser.js";
import { CodexParser } from "./codex-parser.js";

// Registry of capturable hosts (engram#261). Add a host by adding an
// adapter here — the watcher, syncer, and status are all host-agnostic.

const claudeCodeAdapter: HostAdapter = {
  id: "claude-code",
  label: "Claude Code",
  watchDir: join(homedir(), ".claude", "projects"),
  available() {
    return existsSync(this.watchDir);
  },
  createParser(onMessages: OnMessages) {
    return new Parser(onMessages);
  },
};

const codexAdapter: HostAdapter = {
  id: "codex",
  label: "Codex CLI",
  watchDir: join(homedir(), ".codex", "sessions"),
  available() {
    return existsSync(this.watchDir);
  },
  createParser(onMessages: OnMessages) {
    return new CodexParser(onMessages);
  },
};

export const ALL_ADAPTERS: HostAdapter[] = [claudeCodeAdapter, codexAdapter];

/** Adapters whose host is actually installed on this machine. */
export function availableAdapters(): HostAdapter[] {
  return ALL_ADAPTERS.filter((a) => a.available());
}
