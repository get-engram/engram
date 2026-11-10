import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Probe } from "../daemon/instance.js";

/**
 * engram#677 — `engram status` when ~/.engram/vault-key is there but can't
 * be read, and while the daemon holds messages for it: why, the fix, what
 * waits, and that commands that need the key won't run, said once. A file
 * that isn't there is no vault, unless the daemon was holding messages for
 * a key, which it goes on doing.
 *
 * process.platform is linux, child_process is a fake, and nothing reaches
 * systemd, ~/.config or the real ~/.engram; no process is signalled.
 */

const { home, daemon, requests, spawn, execSync, execFileSync, execFile } = vi.hoisted(() => ({
  home: { dir: "" },
  // What answers on the daemon's socket: a daemon, or nothing.
  daemon: { answering: null as { pid: number } | null },
  requests: [] as string[],
  spawn: vi.fn(),
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  execFile: vi.fn(),
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
  execFile,
}));
// An install has dist/daemon/worker.js beside launch.js; under vitest the
// module beside launch.ts is worker.ts. Point at a file that exists.
vi.mock("../daemon/launch.js", async (importOriginal) => {
  const path = await import("node:path");
  return {
    ...(await importOriginal<typeof import("../daemon/launch.js")>()),
    workerPath: () => path.join(home.dir, "cli", "dist", "daemon", "worker.js"),
  };
});
vi.mock("../daemon/worker.js", () => ({}));
vi.mock("../daemon/instance.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../daemon/instance.js")>();
  const probeDaemon = async (): Promise<Probe> => {
    const a = daemon.answering;
    if (a === null) return { state: "none", stale: false };
    return { state: "answered", info: { ready: true, stopping: false, stopFile: false, vaultKeyReread: true, version: real.VERSION, ...a } };
  };
  return { ...real, probeDaemon };
});
// Everything in ~/.engram is the user's (engram#659 has the rest).
vi.mock("../daemon/ownership.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/ownership.js")>()),
  foreignFiles: () => null,
}));

/** The OS this runs on. */
const HOST = process.platform;

home.dir = mkdtempSync(join(tmpdir(), "engram-677-status-"));
const XDG = join(home.dir, "config");
const NO_BIN = join(home.dir, "no-bin");
const WORKER = join(home.dir, "cli", "dist", "daemon", "worker.js");
const ENGRAM_DIR = join(home.dir, ".engram");
const CONFIG_FILE = join(ENGRAM_DIR, "config.json");
const KEY_FILE = join(ENGRAM_DIR, "vault-key");
const STATUS_FILE = join(ENGRAM_DIR, "status.json");
mkdirSync(dirname(WORKER), { recursive: true });
writeFileSync(WORKER, "");
mkdirSync(NO_BIN);

const { daemonStatus } = await import("../daemon/commands.js");

const SINCE = "2026-11-10T00:00:00.000Z";
const VAULT_KEY = Buffer.alloc(32, 7).toString("base64");
const ENV_VAULT_KEY = Buffer.alloc(32, 9).toString("base64");

const FOLDER = [
  "  WARNING: ~/.engram/vault-key is a folder, not a file.",
  "  Move the folder aside, and put your vault key back in ~/.engram/vault-key.",
];
const REFUSED = "  Meanwhile, commands that need the key won't run.";
/** What waits while the daemon holds messages for the key: 2 of them here. */
const held = (refused: boolean) => [
  "  Meanwhile, messages wait here rather than be sent with your vault's secrets",
  `  in them${refused ? ", and commands that need the key won't run" : ""}. Nothing is lost.`,
  "  2 messages waiting to sync",
  `  Last error: ${SINCE}`,
];

afterAll(() => {
  rmSync(home.dir, { recursive: true, force: true });
});

// POSIX hosts only, and not as root, as for engram#659: the commands look
// at the effective uid, and mode 000 stops no one as root.
describe.skipIf(HOST === "win32" || process.geteuid?.() === 0)("engram status, with a vault key that can't be read (engram#677)", () => {
  let out: string[];
  let errs: string[];

  beforeEach(() => {
    out = [];
    errs = [];
    requests.length = 0;
    daemon.answering = null;
    rmSync(XDG, { recursive: true, force: true });
    rmSync(ENGRAM_DIR, { recursive: true, force: true });
    mkdirSync(ENGRAM_DIR, { mode: 0o700 });
    writeFileSync(CONFIG_FILE, JSON.stringify({ apiKey: "engram_sk_live_test_677_status" }));
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    vi.stubEnv("XDG_CONFIG_HOME", XDG);
    vi.stubEnv("PATH", NO_BIN);
    vi.stubEnv("NO_COLOR", "1");
    vi.stubEnv("ENGRAM_API_KEY", undefined);
    vi.stubEnv("ENGRAM_BASE_URL", undefined);
    vi.stubEnv("ENGRAM_VAULT_KEY", undefined);
    for (const name of ["SUDO_UID", "PKEXEC_UID", "DOAS_USER"]) vi.stubEnv(name, undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        requests.push(String(input));
        throw new Error("no requests in these tests");
      }),
    );
    spawn.mockReset();
    execSync.mockReset();
    execFile.mockReset();
    execFileSync.mockReset();
    // Signal 0 finds this process alive; any other signal fails the test before it reaches a process.
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (signal === 0 && pid === process.pid) return true;
      if (signal === 0) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      throw new Error(`a test sent ${String(signal)} to pid ${pid}`);
    }) as typeof process.kill);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void out.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errs.push(args.join(" ")));
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: HOST, configurable: true });
    process.exitCode = undefined;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    try {
      if (lstatSync(KEY_FILE).isFile()) chmodSync(KEY_FILE, 0o600);
    } catch {
      // not there
    }
    // Nothing was started or asked of the network.
    expect(spawn).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  /** A daemon answers on the socket: this process stands in for it. */
  const daemonRunning = () => void (daemon.answering = { pid: process.pid });
  const keyFolder = () => mkdirSync(KEY_FILE);
  /** The daemon's status.json, as it records holding messages for the key. */
  const holding = (extra: Record<string, unknown> = {}) =>
    writeFileSync(
      STATUS_FILE,
      JSON.stringify({
        health: "error",
        error_type: "vault_key",
        last_error:
          "holding messages until the vault key can be read: ~/.engram/vault-key is a folder, not a file",
        last_error_at: SINCE,
        pending_messages: 2,
        consecutive_failures: 3,
        ...extra,
      }),
    );

  /** From the line `first` to the blank line after it, which a blank line comes before. */
  function block(first: string): string[] {
    const at = out.indexOf(first);
    expect(at, `${first}\nin:\n${out.join("\n")}`).toBeGreaterThan(0);
    expect(out[at - 1]).toBe("");
    const end = out.indexOf("", at);
    expect(end).toBeGreaterThan(at);
    return out.slice(at, end);
  }

  const vaultLines = () => out.filter((l) => l.includes("vault"));

  it("stopped: why, the fix, and that commands that need the key won't run", async () => {
    keyFolder();
    await daemonStatus();
    expect(out).toEqual(["Status: stopped", "", ...FOLDER, REFUSED, ""]);
    expect(errs).toEqual([]);
  });

  it("stopped, a key file it can't read (mode 000): how to make it readable", async () => {
    writeFileSync(KEY_FILE, `${VAULT_KEY}\n`);
    chmodSync(KEY_FILE, 0o000);
    await daemonStatus();
    expect(out).toEqual([
      "Status: stopped",
      "",
      "  WARNING: ~/.engram/vault-key can't be read: permission denied.",
      "  Make it readable with: chmod 600 ~/.engram/vault-key",
      REFUSED,
      "",
    ]);
  });

  it("running, holding messages for it: what waits, said once", async () => {
    keyFolder();
    holding();
    daemonRunning();
    await daemonStatus();
    expect(out[0]).toBe(`Status: running (pid ${process.pid})`);
    expect(block(FOLDER[0])).toEqual([...FOLDER, ...held(true)]);
    // Not the generic warning as well, nor the raw error.
    expect(out.filter((l) => l.includes("WARNING"))).toEqual([FOLDER[0]]);
    expect(out.join("\n")).not.toContain("holding messages until");
  });

  it("running, the file reads fine now: the daemon sends what it held on its own", async () => {
    writeFileSync(KEY_FILE, `${VAULT_KEY}\n`);
    holding();
    daemonRunning();
    await daemonStatus();
    expect(block("  Sending is waiting on ~/.engram/vault-key, which reads fine now.")).toEqual([
      "  Sending is waiting on ~/.engram/vault-key, which reads fine now.",
      "  The daemon reads it again within a minute, then sends what it held.",
      "  2 messages waiting to sync",
    ]);
    expect(out.join("\n")).not.toContain("WARNING");
    expect(out.join("\n")).not.toContain(VAULT_KEY);
  });

  it("running, the file gone: still holding, and how to go on without a key", async () => {
    holding();
    daemonRunning();
    await daemonStatus();
    expect(block("  WARNING: ~/.engram/vault-key isn't there any more.")).toEqual([
      "  WARNING: ~/.engram/vault-key isn't there any more.",
      "  Put your vault key back in it.",
      "  If you don't use the vault, run 'engram stop', then 'engram start': the daemon starts without a key, and sends what it held.",
      // Commands run without one: to them, no file is no key.
      ...held(false),
    ]);
  });

  it("with ENGRAM_VAULT_KEY set: commands run here use it, and the daemon still holds", async () => {
    keyFolder();
    holding();
    daemonRunning();
    vi.stubEnv("ENGRAM_VAULT_KEY", ENV_VAULT_KEY);
    await daemonStatus();
    expect(block(FOLDER[0])).toEqual([
      ...FOLDER,
      ...held(false),
      "  Commands run here use ENGRAM_VAULT_KEY instead, which wins over the file.",
    ]);
    expect(out.join("\n")).not.toContain(ENV_VAULT_KEY);
  });

  it("stopped, with ENGRAM_VAULT_KEY set: that commands use it, not that they won't run", async () => {
    keyFolder();
    vi.stubEnv("ENGRAM_VAULT_KEY", ENV_VAULT_KEY);
    await daemonStatus();
    expect(out).toEqual([
      "Status: stopped",
      "",
      ...FOLDER,
      "  Commands run here use ENGRAM_VAULT_KEY instead, which wins over the file.",
      "",
    ]);
  });

  it("signed out: nothing is sent anyway, so nothing is said to wait on the key", async () => {
    keyFolder();
    holding({ signed_out_at: SINCE });
    daemonRunning();
    await daemonStatus();
    expect(block(FOLDER[0])).toEqual([...FOLDER, REFUSED]);
    expect(out).toContain("  Signed out — capture is paused and nothing is sent.");
    expect(out.join("\n")).not.toContain("messages wait here");
  });

  it("running and sending, the key file a folder: said, with nothing held", async () => {
    keyFolder();
    writeFileSync(STATUS_FILE, JSON.stringify({ health: "healthy", last_sync_at: SINCE }));
    daemonRunning();
    await daemonStatus();
    expect(block(FOLDER[0])).toEqual([...FOLDER, REFUSED]);
  });

  it("no key file, nothing held: no vault, and nothing said about one", async () => {
    writeFileSync(STATUS_FILE, JSON.stringify({ health: "healthy", last_sync_at: SINCE }));
    daemonRunning();
    await daemonStatus();
    expect(vaultLines()).toEqual([]);
  });

  it("a key that reads, nothing held: nothing said about it", async () => {
    writeFileSync(KEY_FILE, `${VAULT_KEY}\n`);
    daemonRunning();
    await daemonStatus();
    expect(vaultLines()).toEqual([]);
    expect(out.join("\n")).not.toContain(VAULT_KEY);
  });

  /** engram#693: the daemon read its key from the file, which is gone now. */
  const GONE = [
    "  WARNING: ~/.engram/vault-key isn't there any more.",
    "  The daemon still removes your vault's secrets from what it captures, with the",
    "  key it read before. When it restarts, it starts without one: put the key back",
    "  if you still use the vault.",
  ];
  /** The daemon's status.json, sending, with its key from `vaultKey`. */
  const sending = (vaultKey: string | null, extra: Record<string, unknown> = {}) =>
    writeFileSync(
      STATUS_FILE,
      JSON.stringify({ health: "healthy", last_sync_at: SINCE, vault_key: vaultKey, ...extra }),
    );

  it("running, the key it read from the file gone: it goes on with it until it restarts (engram#693)", async () => {
    sending("file");
    daemonRunning();
    await daemonStatus();
    expect(block(GONE[0])).toEqual(GONE);
    expect(out.filter((l) => l.includes("WARNING"))).toEqual([GONE[0]]);
    // Signed out, it still has the key for when it is signed in again.
    out = [];
    sending("file", { signed_out_at: SINCE });
    await daemonStatus();
    expect(block(GONE[0])).toEqual(GONE);
  });

  it("the key there, or the daemon's from ENGRAM_VAULT_KEY or none: nothing about a key gone (engram#693)", async () => {
    writeFileSync(KEY_FILE, `${VAULT_KEY}\n`);
    sending("file");
    daemonRunning();
    await daemonStatus();
    expect(vaultLines()).toEqual([]);
    rmSync(KEY_FILE);
    for (const vaultKey of ["env", null]) {
      out = [];
      sending(vaultKey);
      await daemonStatus();
      expect(vaultLines(), String(vaultKey)).toEqual([]);
    }
  });

  it("holding messages for the key, the file gone: said as before, once (engram#693)", async () => {
    holding({ vault_key: "file" });
    daemonRunning();
    await daemonStatus();
    expect(out.filter((l) => l.includes("WARNING"))).toEqual([GONE[0]]);
    expect(out).toContain("  Put your vault key back in it.");
    expect(out).not.toContain(GONE[1]);
  });

  it("running on the key it read from the file, now a folder: that is said, not that the file is gone (engram#693)", async () => {
    keyFolder();
    sending("file");
    daemonRunning();
    await daemonStatus();
    expect(block(FOLDER[0])).toEqual([...FOLDER, REFUSED]);
    expect(out).not.toContain(GONE[0]);
    expect(out).not.toContain(GONE[1]);
  });

  it("stopped: what the last daemon read says nothing of the next one (engram#693)", async () => {
    sending("file");
    await daemonStatus();
    expect(vaultLines()).toEqual([]);
  });
});
