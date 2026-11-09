import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedMessage } from "../daemon/types.js";

/**
 * engram#628 — `engram daemon status` printed "1 messages", and colored
 * output that went to a pipe. These run the real command against a
 * daemon.db and status.json in a temp home. Nothing reaches the real
 * ~/.engram, launchd or the registry, and no key is sent anywhere.
 */

const { home, execSync, execFileSync, spawn } = vi.hoisted(() => ({
  home: { dir: "" },
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn,
  execSync,
  execFileSync,
  execFile: vi.fn(),
}));

const KEY = "engram-test-key-628";
vi.mock("../config.js", () => ({
  loadConfig: vi.fn(async () => ({ apiKey: "engram-test-key-628" })),
  saveConfig: vi.fn(async () => {}),
  getBaseUrl: () => "https://engram.invalid",
  resolveBaseUrl: () => "https://engram.invalid",
}));

home.dir = mkdtempSync(join(tmpdir(), "engram-628-"));
const ENGRAM_DIR = join(home.dir, ".engram");

const { daemonStatus } = await import("../daemon/commands.js");
const { DaemonDb } = await import("../daemon/db.js");
const { keyFingerprint } = await import("../daemon/syncer.js");

const ESC = "\x1b[";
const streams = [process.stdout, process.stderr] as const;
let saved: Array<PropertyDescriptor | undefined>;

function terminals(on: boolean): void {
  for (const s of streams) Object.defineProperty(s, "isTTY", { value: on, configurable: true, writable: true });
}

beforeEach(() => {
  // Nothing here may run launchctl or reg.exe for real.
  expect(vi.isMockFunction(execSync)).toBe(true);
  expect(vi.isMockFunction(execFileSync)).toBe(true);
  execSync.mockReset();
  execFileSync.mockReset();
  // The key comes from the (mocked) config, never from this environment.
  vi.stubEnv("ENGRAM_API_KEY", "");
  vi.stubEnv("NO_COLOR", undefined);
  vi.stubEnv("TERM", "xterm-256color");
  saved = streams.map((s) => Object.getOwnPropertyDescriptor(s, "isTTY"));
  terminals(false); // `engram daemon status | cat`
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  rmSync(ENGRAM_DIR, { recursive: true, force: true });
  mkdirSync(ENGRAM_DIR);
});

afterEach(() => {
  streams.forEach((s, i) => {
    const d = saved[i];
    if (d) Object.defineProperty(s, "isTTY", d);
    else delete (s as { isTTY?: boolean }).isTTY;
  });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(() => rmSync(home.dir, { recursive: true, force: true }));

const output = () => vi.mocked(console.log).mock.calls.map((c) => c.map(String).join(" "));

function msgs(n: number): ParsedMessage[] {
  return Array.from({ length: n }, (_, i) => ({ role: "user", content: `m${i}` }));
}

/** daemon.db with `pending` messages queued under the configured key and
 *  `held` under another account's. */
function queue(pending: number, held: number): void {
  const db = new DaemonDb(join(ENGRAM_DIR, "daemon.db"));
  try {
    if (pending > 0) db.enqueue("conv_mine", msgs(pending), keyFingerprint(KEY));
    if (held > 0) db.enqueue("conv_other", msgs(held), keyFingerprint("engram-test-key-other"));
  } finally {
    db.close();
  }
}

const HELD_NOTE = "(another account's — sent when it signs in again)";

describe("engram daemon status (engram#628)", () => {
  it("says 1 message, not 1 messages, with no escape codes into a pipe", async () => {
    queue(1, 1);
    await daemonStatus();
    const lines = output();
    expect(lines).toContain("Status: stopped");
    expect(lines).toContain("Pending sync:      1 message");
    expect(lines).toContain(`Held:              1 message ${HELD_NOTE}`);
    expect(lines.join("\n")).not.toContain(ESC);
    expect(lines.join("\n")).not.toMatch(/\b1 messages\b/);
    expect(execSync).not.toHaveBeenCalled();
  });

  it("counts other numbers in the plural", async () => {
    queue(2, 1234);
    await daemonStatus();
    expect(output()).toContain("Pending sync:      2 messages");
    expect(output()).toContain(`Held:              1,234 messages ${HELD_NOTE}`);
  });

  it("says 0 messages when nothing is queued, and has no held line", async () => {
    queue(0, 0);
    await daemonStatus();
    expect(output()).toContain("Pending sync:      0 messages");
    expect(output().some((l) => l.startsWith("Held:"))).toBe(false);
  });

  it("says 1 message waiting to sync in the sync warning", async () => {
    // A running daemon: this process stands in for it.
    writeFileSync(join(ENGRAM_DIR, "daemon.pid"), String(process.pid));
    writeFileSync(
      join(ENGRAM_DIR, "status.json"),
      JSON.stringify({
        health: "error",
        error_type: "server",
        pending_messages: 1,
        last_error_at: "2026-11-09T00:00:00.000Z",
      }),
    );
    await daemonStatus();
    const lines = output();
    expect(lines).toContain(`Status: running (pid ${process.pid})`);
    expect(lines).toContain("  WARNING: Server error — messages queued, will retry.");
    expect(lines).toContain("  1 message waiting to sync");
    expect(lines.join("\n")).not.toContain(ESC);
  });

  it("is colored on a terminal", async () => {
    terminals(true);
    queue(1, 0);
    await daemonStatus();
    expect(output()).toContain("\x1b[2mPending sync:\x1b[0m      1 message");
    expect(output()).toContain("\x1b[1mStatus:\x1b[0m stopped");
  });
});
