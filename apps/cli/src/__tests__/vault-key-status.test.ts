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
    return { state: "answered", info: { ready: true, stopping: false, stopFile: false, vaultKeyReread: true, vaultChangeNotice: true, version: real.VERSION, ...a } };
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

  /** engram#694: the daemon's status.json, holding sends for a key that decrypts none of the vault's secrets. */
  const mismatched = (extra: Record<string, unknown> = {}) =>
    writeFileSync(
      STATUS_FILE,
      JSON.stringify({
        health: "error",
        error_type: "vault_mismatch",
        last_error:
          "holding messages until the vault's secrets can be scrubbed: the vault key doesn't decrypt any of the vault's 2 secrets",
        last_error_at: SINCE,
        pending_messages: 2,
        consecutive_failures: 3,
        vault_key: "file",
        vault_undecryptable: { secrets: 2, unscrubbed: 2, decrypted: 0, held: true },
        ...extra,
      }),
    );
  /** What `engram status` says of a hold for two secrets it can't remove, after the headline. */
  const HELD_FOR_TWO = [
    "  They were saved with another key, so the daemon can't remove them from",
    "  what it captures. Meanwhile, messages wait here rather than be sent with your",
    "  vault's secrets in them. Nothing is lost. To send what waits, do one of these:",
    "    Put the key they were saved with in ~/.engram/vault-key.",
    "    Save each again with this key: engram vault set <NAME>",
    "    Delete each you no longer use: engram vault delete <NAME>",
    "  'engram vault list' lists them. Then the daemon sends what it held within",
    "  5 minutes.",
  ];
  const MISMATCH = "  WARNING: Your vault key doesn't decrypt any of your vault's 2 secrets.";
  /** What `engram status` says of a key that decrypts some of the vault's secrets. */
  const PARTIAL = /^ {2}WARNING: \d+ secrets? in your vault (?:doesn't|don't) decrypt/;

  it("running, holding sends for a key that decrypts none of the vault's secrets: why, what waits, the fixes (engram#694)", async () => {
    writeFileSync(KEY_FILE, `${VAULT_KEY}\n`);
    mismatched();
    daemonRunning();
    await daemonStatus();
    expect(block(MISMATCH)).toEqual([MISMATCH, ...HELD_FOR_TWO, "  2 messages waiting to sync", `  Last error: ${SINCE}`]);
    // Said once: not the summary as well, nor the raw error, nor that some don't decrypt.
    expect(out.filter((l) => l.includes("WARNING"))).toEqual([MISMATCH]);
    expect(out.join("\n")).not.toContain("holding messages until");
    expect(out.filter((l) => PARTIAL.test(l))).toEqual([]);
    expect(out.join("\n")).not.toContain(VAULT_KEY);
  });

  it("holding sends, the daemon's key from ENGRAM_VAULT_KEY and one secret: set it again and restart from that shell (engram#694)", async () => {
    mismatched({
      vault_key: "env",
      vault_undecryptable: { secrets: 1, unscrubbed: 1, decrypted: 0, held: true },
      pending_messages: 1,
    });
    daemonRunning();
    await daemonStatus();
    expect(block("  WARNING: Your vault key doesn't decrypt your vault's secret.")).toEqual([
      "  WARNING: Your vault key doesn't decrypt your vault's secret.",
      "  It was saved with another key, so the daemon can't remove it from",
      "  what it captures. Meanwhile, messages wait here rather than be sent with your",
      "  vault's secrets in them. Nothing is lost. To send what waits, do one of these:",
      "    Set ENGRAM_VAULT_KEY to the key it was saved with, then run",
      "    'engram stop' and 'engram start' from that shell.",
      "    Save it again with this key: engram vault set <NAME>",
      "    Delete it, if you no longer use it: engram vault delete <NAME>",
      "  'engram vault list' lists it. Then the daemon sends what it held within",
      "  5 minutes.",
      "  1 message waiting to sync",
      `  Last error: ${SINCE}`,
    ]);
  });

  it("holding sends since it decrypted none, some decrypting now: how many still don't, and the fixes but their key (engram#694)", async () => {
    writeFileSync(KEY_FILE, `${VAULT_KEY}\n`);
    mismatched({
      last_error:
        "holding messages until the vault's secrets can be scrubbed: the vault key doesn't decrypt 2 of the vault's 3 secrets",
      vault_undecryptable: { secrets: 2, unscrubbed: 2, decrypted: 1, held: true },
    });
    daemonRunning();
    await daemonStatus();
    const first = "  WARNING: 2 of your vault's 3 secrets don't decrypt with your vault key.";
    expect(block(first)).toEqual([
      first,
      "  They were saved with another key, so the daemon can't remove them from",
      "  what it captures. Meanwhile, messages wait here rather than be sent with your",
      "  vault's secrets in them. Nothing is lost. To send what waits, do one of these:",
      "    Save each again with this key: engram vault set <NAME>",
      "    Delete each you no longer use: engram vault delete <NAME>",
      "  'engram vault list --check' shows which. Then the daemon sends what it held",
      "  within 5 minutes.",
      "  2 messages waiting to sync",
      `  Last error: ${SINCE}`,
    ]);
    // Not the key they were saved with: the one that decrypts now wouldn't
    // with it. Nor that sending goes on.
    expect(out.join("\n")).not.toContain("Put the key");
    expect(out.filter((l) => PARTIAL.test(l))).toEqual([]);
    expect(out.filter((l) => l.includes("WARNING"))).toEqual([first]);
    // One of three, the daemon's key from ENGRAM_VAULT_KEY: not to set it again either.
    out = [];
    mismatched({
      vault_key: "env",
      vault_undecryptable: { secrets: 1, unscrubbed: 1, decrypted: 2, held: true },
      pending_messages: 1,
    });
    await daemonStatus();
    const one = "  WARNING: 1 of your vault's 3 secrets doesn't decrypt with your vault key.";
    expect(block(one)).toEqual([
      one,
      "  It was saved with another key, so the daemon can't remove it from",
      "  what it captures. Meanwhile, messages wait here rather than be sent with your",
      "  vault's secrets in them. Nothing is lost. To send what waits, do one of these:",
      "    Save it again with this key: engram vault set <NAME>",
      "    Delete it, if you no longer use it: engram vault delete <NAME>",
      "  'engram vault list --check' shows which. Then the daemon sends what it held",
      "  within 5 minutes.",
      "  1 message waiting to sync",
      `  Last error: ${SINCE}`,
    ]);
    expect(out.join("\n")).not.toContain("Set ENGRAM_VAULT_KEY");
  });

  it("holding sends with nothing waiting yet: said, since what it captures next waits (engram#694)", async () => {
    writeFileSync(KEY_FILE, `${VAULT_KEY}\n`);
    // As a daemon just started writes it, holding still what the one
    // before held: nothing has gone, or failed, yet. The last error is
    // another's, from before.
    sending("file", {
      last_error_at: SINCE,
      vault_undecryptable: { secrets: 2, unscrubbed: 2, decrypted: 0, held: true },
    });
    daemonRunning();
    await daemonStatus();
    expect(block(MISMATCH)).toEqual([MISMATCH, ...HELD_FOR_TWO]);
    expect(out).toContain(`Last sync:        ${SINCE}`);
    expect(out.filter((l) => l.includes("WARNING"))).toEqual([MISMATCH]);
    expect(out.join("\n")).not.toContain("waiting to sync");
    expect(out.join("\n")).not.toContain("Last error");
  });

  it("holding sends with no count recorded: said without one (engram#694)", async () => {
    mismatched({ vault_undecryptable: null, pending_messages: 0, last_error_at: null });
    daemonRunning();
    await daemonStatus();
    const first = "  WARNING: Your vault key doesn't decrypt any of your vault's secrets.";
    expect(block(first).slice(0, 2)).toEqual([
      first,
      "  They were saved with another key, so the daemon can't remove them from",
    ]);
    expect(out.join("\n")).not.toContain("waiting to sync");
    expect(out.join("\n")).not.toContain("Last error");
  });

  it("signed out, or stopped: nothing is said of the key's secrets (engram#694)", async () => {
    writeFileSync(KEY_FILE, `${VAULT_KEY}\n`);
    mismatched({ signed_out_at: SINCE });
    daemonRunning();
    await daemonStatus();
    expect(out).toContain("  Signed out — capture is paused and nothing is sent.");
    expect(vaultLines()).toEqual([]);
    out = [];
    daemon.answering = null;
    mismatched();
    await daemonStatus();
    expect(vaultLines()).toEqual([]);
    out = [];
    sending("file", { vault_undecryptable: { secrets: 2, unscrubbed: 2, decrypted: 1, held: false } });
    await daemonStatus();
    expect(vaultLines()).toEqual([]);
    out = [];
    sending("file", { vault_undecryptable: { secrets: 2, unscrubbed: 2, decrypted: 0, held: true } });
    await daemonStatus();
    expect(vaultLines()).toEqual([]);
  });

  const FIX = [
    "  Save each again with this key (engram vault set <NAME>), or delete each you",
    "  no longer use (engram vault delete <NAME>). 'engram vault list --check'",
    "  shows which don't decrypt.",
  ];

  it("sending, with a key that decrypts some of the vault's secrets: how many it can't remove, and the fix (engram#694)", async () => {
    writeFileSync(KEY_FILE, `${VAULT_KEY}\n`);
    sending("file", { vault_undecryptable: { secrets: 2, unscrubbed: 2, decrypted: 1, held: false } });
    daemonRunning();
    await daemonStatus();
    const first = "  WARNING: 2 secrets in your vault don't decrypt with your vault key.";
    expect(block(first)).toEqual([
      first,
      "  They were saved with another key, so the daemon can't remove them from",
      "  what it captures before sending it.",
      ...FIX,
    ]);
    expect(out).toContain(`Last sync:        ${SINCE}`);
    // Not putting their key back: the others don't decrypt with it.
    expect(out.join("\n")).not.toContain("Put the key");
    expect(out.join("\n")).not.toContain("messages wait here");
  });

  it("sending, with values for them read before: removed until it restarts (engram#694)", async () => {
    writeFileSync(KEY_FILE, `${VAULT_KEY}\n`);
    sending("file", { vault_undecryptable: { secrets: 1, unscrubbed: 0, decrypted: 1, held: false } });
    daemonRunning();
    await daemonStatus();
    const first = "  WARNING: 1 secret in your vault doesn't decrypt with your vault key.";
    expect(block(first)).toEqual([
      first,
      "  It was saved with another key. The daemon still removes it from what",
      "  it captures, with what it read before, but can't once it restarts.",
      "  Save it again with this key (engram vault set <NAME>), or delete it if you",
      "  no longer use it (engram vault delete <NAME>). 'engram vault list --check'",
      "  shows which don't decrypt.",
    ]);
    out = [];
    sending("file", { vault_undecryptable: { secrets: 3, unscrubbed: 1, decrypted: 1, held: false } });
    await daemonStatus();
    const three = "  WARNING: 3 secrets in your vault don't decrypt with your vault key.";
    expect(block(three)).toEqual([
      three,
      "  They were saved with another key. The daemon can't remove 1 of them from",
      "  what it captures before sending it, and the others only until it restarts.",
      ...FIX,
    ]);
  });

  it("failing for another reason, with a key that decrypts some: both are said (engram#694)", async () => {
    writeFileSync(KEY_FILE, `${VAULT_KEY}\n`);
    sending("file", {
      health: "warning",
      error_type: "network",
      last_error: "fetch failed",
      last_error_at: SINCE,
      pending_messages: 4,
      vault_undecryptable: { secrets: 2, unscrubbed: 2, decrypted: 1, held: false },
    });
    daemonRunning();
    await daemonStatus();
    expect(out.filter((l) => l.includes("WARNING"))).toEqual([
      "  WARNING: 2 secrets in your vault don't decrypt with your vault key.",
      "  WARNING: Can't reach Engram — messages queued, will retry.",
    ]);
  });
});
