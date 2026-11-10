import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngramError, type Engram } from "@getengram/sdk";
import type { VaultKeySource, VaultLike } from "../daemon/scrubber.js";

// engram#701: a secret saved with `engram vault set` while the daemon ran
// went out unscrubbed until the daemon read the vault again, on its
// 10-minute interval. `engram vault set` and `engram vault delete` now leave
// a notice in ~/.engram/vault-changed, and the daemon reads the vault before
// its next send when it finds a new one. These tests pin "a send after the
// notice waits for a read of the vault begun after it".

const { home, pidFileDaemon } = vi.hoisted(() => ({
  home: { dir: "" },
  pidFileDaemon: { pid: null as number | null },
}));

// The notice, the daemon's socket and its PID file are in ~/.engram: a temp home.
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));
// A daemon from before engram#612 has no socket: its PID file names it,
// and only `ps` tells it from another process. A test says there is one.
vi.mock("../daemon/instance.js", async (importOriginal) => {
  const instance = await importOriginal<typeof import("../daemon/instance.js")>();
  return {
    ...instance,
    confirmedDaemonInPidFile: () => pidFileDaemon.pid ?? instance.confirmedDaemonInPidFile(),
  };
});

home.dir = mkdtempSync(join(tmpdir(), "engram-701-home-"));
const ENGRAM = join(home.dir, ".engram");

// After the temp home is set: these take their paths from it when imported.
const { noteVaultChanged, readVaultChanged, VAULT_CHANGED_FILE } = await import("../daemon/vault-changed.js");
const { SecretScrubber, MAX_SERVER_HOLD_MS, READ_RETRY_MS } = await import("../daemon/scrubber.js");
const { VaultKeyUnreadable } = await import("../vault-key.js");
const { vaultDelete, vaultSet } = await import("../commands/vault.js");
const { daemonEndpoint } = await import("../daemon/instance.js");

// Never the developer's own ~/.engram.
if (VAULT_CHANGED_FILE !== join(ENGRAM, "vault-changed")) {
  throw new Error(`the notice would be written to ${VAULT_CHANGED_FILE}`);
}

process.on("exit", () => rmSync(home.dir, { recursive: true, force: true }));

const posix = process.platform !== "win32";
/** FIFOs and modes: off Windows. */
const posixIt = it.skipIf(!posix);

const KEY = "base64-vault-key-value";

/** What the SDK throws when fetch fails: no answer at all. */
const offline = () => new EngramError("Network error: fetch failed");
/** An HTTP 503 with a JSON body: the message is empty, the status says it. */
const unavailable = () => new EngramError("", "undefined", 503);
/** WebCrypto's error for a value that doesn't decrypt with this key. */
const wrongKey = () =>
  new DOMException("The operation failed for an operation-specific reason", "OperationError");

/** A vault whose answers the test decides. */
class FakeVault implements VaultLike {
  lists = 0;
  gets: string[] = [];
  listError: (() => unknown) | null = null;
  getErrors: Record<string, () => unknown> = {};
  private gate: Promise<void> | null = null;
  private open: (() => void) | null = null;

  constructor(public secrets: Record<string, string>) {}

  /** Hold each list() from now on until release(): it answers with the vault as it was when called. */
  hold(): void {
    this.gate = new Promise((r) => (this.open = r));
  }

  release(): void {
    this.open?.();
    this.gate = null;
  }

  async list(): Promise<Array<{ name: string }>> {
    this.lists++;
    if (this.listError) throw this.listError();
    const listed = Object.keys(this.secrets).map((name) => ({ name }));
    if (this.gate) await this.gate;
    return listed;
  }

  async get(name: string): Promise<string | null> {
    this.gets.push(name);
    const fail = this.getErrors[name];
    if (fail) throw fail();
    return this.secrets[name] ?? null;
  }
}

/** The notice the daemon finds: `engram vault set` writes a new one. */
class Notices {
  now: string | null = null;
  fails = false;
  private written = 0;

  write(): void {
    this.now = `notice ${++this.written}`;
  }

  readonly read = (): string | null => {
    if (this.fails) throw new Error("EIO: i/o error, read");
    return this.now;
  };
}

const CHANGED = "vault scrubber: the vault changed — reading it again before sending";

const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

/** Let pending promise callbacks run (setImmediate isn't faked). */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

let scrubbers: Array<InstanceType<typeof SecretScrubber>> = [];
let log: string[] = [];

/** A scrubber that follows `notices`, as worker-main makes it: not started. */
function following(
  vault: FakeVault | null,
  notices: Notices,
  key?: { source: VaultKeySource; problem?: unknown },
): InstanceType<typeof SecretScrubber> {
  const scrubber = new SecretScrubber(vault, key ? undefined : KEY, (msg) => void log.push(msg), key);
  scrubber.followChanges(notices.read);
  scrubbers.push(scrubber);
  return scrubber;
}

/** Started, with its first read done. */
async function running(vault: FakeVault, notices: Notices): Promise<InstanceType<typeof SecretScrubber>> {
  const scrubber = following(vault, notices);
  scrubber.start();
  expect(await scrubber.ready()).toBe(true);
  expect(vault.lists).toBe(1);
  return scrubber;
}

/** Fake Date, and `timers` too. */
function fakeTime(timers: Array<"setInterval" | "clearInterval"> = []): void {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ["Date", ...timers] });
  vi.setSystemTime(new Date("2026-11-10T00:00:00Z"));
}

describe("a secret saved while the daemon runs (engram#701)", () => {
  beforeEach(() => {
    fakeTime();
    log = [];
  });

  afterEach(() => {
    for (const scrubber of scrubbers) scrubber.stop();
    scrubbers = [];
    vi.useRealTimers();
  });

  it("is scrubbed from the next send on: the notice has the vault read first", async () => {
    const vault = new FakeVault({ A: "alpha-secret-1" });
    const notices = new Notices();
    const scrubber = await running(vault, notices);

    vault.secrets.B = "bravo-secret-2";
    notices.write();
    expect(await scrubber.ready()).toBe(true);
    expect(vault.lists).toBe(2);
    expect(scrubber.scrub("use bravo-secret-2 here").text).toBe("use [VAULT:B] here");
    expect(log.filter((line) => line === CHANGED)).toHaveLength(1);

    // Seen once: the sends after it don't read the vault again.
    expect(await scrubber.ready()).toBe(true);
    expect(vault.lists).toBe(2);
  });

  it("saved with no notice, as on another machine: read on the interval, not before the next send", async () => {
    const vault = new FakeVault({ A: "alpha-secret-1" });
    const notices = new Notices();
    const scrubber = await running(vault, notices);

    vault.secrets.B = "bravo-secret-2";
    expect(await scrubber.ready()).toBe(true);
    expect(vault.lists).toBe(1);
    expect(scrubber.scrub("bravo-secret-2").text).toBe("bravo-secret-2");
    expect(log).not.toContain(CHANGED);
  });

  it("a read under way when the notice came may have listed the vault before: sends wait for the one after it", async () => {
    const vault = new FakeVault({ A: "alpha-secret-1" });
    const notices = new Notices();
    const scrubber = following(vault, notices);
    vault.hold();
    scrubber.start();
    await settle();
    expect(vault.lists).toBe(1);

    vault.secrets.B = "bravo-secret-2";
    notices.write();
    const answers: boolean[] = [];
    void scrubber.ready().then((ok) => void answers.push(ok));
    await settle();
    // The read from before the notice ends, and the one after it begins, held.
    vault.release();
    vault.hold();
    await settle();
    expect(vault.lists).toBe(2);
    // What the read before found is scrubbed, but no send goes on it.
    expect(scrubber.scrub("alpha-secret-1").text).toBe("[VAULT:A]");
    void scrubber.ready().then((ok) => void answers.push(ok));
    await settle();
    expect(answers).toEqual([]);

    vault.release();
    await settle();
    expect(answers).toEqual([true, true]);
    expect(vault.lists).toBe(2);
    expect(scrubber.scrub("bravo-secret-2").text).toBe("[VAULT:B]");
  });

  it("the vault can't be listed after the notice: sends wait, as for the first read", async () => {
    const vault = new FakeVault({ A: "alpha-secret-1" });
    const notices = new Notices();
    const scrubber = await running(vault, notices);

    // No answer at all: they wait for one, however long that takes.
    vault.secrets.B = "bravo-secret-2";
    vault.listError = offline;
    notices.write();
    expect(await scrubber.ready()).toBe(false);
    later(MAX_SERVER_HOLD_MS);
    expect(await scrubber.ready()).toBe(false);
    vault.listError = null;
    later(READ_RETRY_MS[READ_RETRY_MS.length - 1]);
    expect(await scrubber.ready()).toBe(true);
    expect(scrubber.scrub("bravo-secret-2").text).toBe("[VAULT:B]");

    // The server's errors: they wait MAX_SERVER_HOLD_MS at most.
    vault.secrets.C = "charlie-secret-3";
    vault.listError = unavailable;
    notices.write();
    expect(await scrubber.ready()).toBe(false);
    later(MAX_SERVER_HOLD_MS);
    expect(await scrubber.ready()).toBe(true);
    expect(log.filter((line) => line.startsWith("vault scrubber: the vault has failed to read for 15 minutes"))).toHaveLength(1);
    expect(scrubber.scrub("charlie-secret-3").text).toBe("charlie-secret-3");
  });

  it("a secret that can't be read after the notice: sends wait, for it may be the one saved again", async () => {
    const vault = new FakeVault({ A: "alpha-secret-1" });
    const notices = new Notices();
    const scrubber = await running(vault, notices);

    vault.secrets.A = "alpha-secret-NEW";
    vault.getErrors.A = unavailable;
    notices.write();
    expect(await scrubber.ready()).toBe(false);
    // The value read before is scrubbed still.
    expect(scrubber.scrub("alpha-secret-1").text).toBe("[VAULT:A]");

    delete vault.getErrors.A;
    later(READ_RETRY_MS[0]);
    expect(await scrubber.ready()).toBe(true);
    expect(scrubber.scrub("alpha-secret-NEW").text).toBe("[VAULT:A]");
  });

  it("a notice there before the daemon started is no change: it reads the vault as it starts", async () => {
    const vault = new FakeVault({ A: "alpha-secret-1" });
    const notices = new Notices();
    notices.write();
    const scrubber = await running(vault, notices);
    expect(await scrubber.ready()).toBe(true);
    expect(vault.lists).toBe(1);
    expect(log).not.toContain(CHANGED);
  });

  it("a notice removed, or one that can't be read, is no change: nor is the same one read again after", async () => {
    const vault = new FakeVault({ A: "alpha-secret-1" });
    const notices = new Notices();
    const scrubber = await running(vault, notices);
    notices.write();
    expect(await scrubber.ready()).toBe(true);
    expect(vault.lists).toBe(2);

    // The vault was read for it already.
    const first = notices.now;
    notices.fails = true;
    expect(await scrubber.ready()).toBe(true);
    notices.fails = false;
    expect(await scrubber.ready()).toBe(true);
    notices.now = null;
    expect(await scrubber.ready()).toBe(true);
    notices.now = first;
    expect(await scrubber.ready()).toBe(true);
    expect(vault.lists).toBe(2);

    notices.now = null;
    expect(await scrubber.ready()).toBe(true);
    notices.write();
    notices.fails = true;
    expect(await scrubber.ready()).toBe(true);
    expect(vault.lists).toBe(2);

    // A new one, read at last: it is one.
    notices.fails = false;
    expect(await scrubber.ready()).toBe(true);
    expect(vault.lists).toBe(3);
    expect(log.filter((l) => l === CHANGED)).toHaveLength(2);
  });

  it("sends at the same moment read the vault once", async () => {
    const vault = new FakeVault({ A: "alpha-secret-1" });
    const notices = new Notices();
    const scrubber = await running(vault, notices);

    vault.secrets.B = "bravo-secret-2";
    notices.write();
    expect(await Promise.all([scrubber.ready(), scrubber.ready(), scrubber.ready()])).toEqual([true, true, true]);
    expect(vault.lists).toBe(2);
    expect(log.filter((line) => line === CHANGED)).toHaveLength(1);
    expect(scrubber.scrub("bravo-secret-2").text).toBe("[VAULT:B]");
  });

  it("the interval finds the notice too: it reads the vault, and the send after needs no read", async () => {
    fakeTime(["setInterval", "clearInterval"]);
    const vault = new FakeVault({ A: "alpha-secret-1" });
    const notices = new Notices();
    const scrubber = await running(vault, notices);

    vault.secrets.B = "bravo-secret-2";
    notices.write();
    vi.advanceTimersByTime(10 * 60_000);
    await settle();
    expect(vault.lists).toBe(2);
    expect(scrubber.scrub("bravo-secret-2").text).toBe("[VAULT:B]");
    expect(await scrubber.ready()).toBe(true);
    expect(vault.lists).toBe(2);
  });

  it("the interval finds the notice while a read is under way: the read after it begins at once", async () => {
    fakeTime(["setInterval", "clearInterval"]);
    const vault = new FakeVault({ A: "alpha-secret-1" });
    const notices = new Notices();
    const scrubber = await running(vault, notices);

    vault.hold();
    vi.advanceTimersByTime(10 * 60_000);
    await settle();
    expect(vault.lists).toBe(2);
    vault.secrets.B = "bravo-secret-2";
    notices.write();
    vi.advanceTimersByTime(10 * 60_000);
    await settle();
    expect(vault.lists).toBe(2);

    // No send asked for it.
    vault.release();
    await settle();
    expect(vault.lists).toBe(3);
    expect(scrubber.scrub("bravo-secret-2").text).toBe("[VAULT:B]");
    expect(await scrubber.ready()).toBe(true);
    expect(vault.lists).toBe(3);
  });

  it("sends wait for a secret the key doesn't decrypt (engram#694): after a notice, each secret is read at once", async () => {
    const vault = new FakeVault({ A: "alpha-secret-1" });
    vault.getErrors.A = wrongKey;
    const notices = new Notices();
    const scrubber = following(vault, notices);
    scrubber.start();
    expect(await scrubber.ready()).toBe(false);
    expect(vault.gets).toEqual(["A"]);
    // Until its retry is due, a send doesn't read the vault.
    expect(await scrubber.ready()).toBe(false);
    expect(vault.lists).toBe(1);

    // The vault listed as before: each secret is read again all the same.
    notices.write();
    expect(await scrubber.ready()).toBe(false);
    expect(vault.lists).toBe(2);
    expect(vault.gets).toEqual(["A", "A"]);
    expect(log).toContain("vault scrubber: still holding sends — the vault key doesn't decrypt the vault's secret");

    // Saved again with the key in use: it decrypts now.
    delete vault.getErrors.A;
    notices.write();
    expect(await scrubber.ready()).toBe(true);
    expect(vault.gets).toEqual(["A", "A", "A"]);
    expect(log).toContain("vault scrubber: the vault key decrypts the vault's secrets now — sending what was held");
  });

  it("sends wait for a secret the key doesn't decrypt (engram#694): deleted, what waited goes at once", async () => {
    const vault = new FakeVault({ A: "alpha-secret-1" });
    vault.getErrors.A = wrongKey;
    const notices = new Notices();
    const scrubber = following(vault, notices);
    scrubber.start();
    expect(await scrubber.ready()).toBe(false);

    delete vault.secrets.A;
    notices.write();
    expect(await scrubber.ready()).toBe(true);
    expect(log).toContain("vault scrubber: the vault holds no secret now that can't be scrubbed — sending what was held");
  });

  it("a hold released at the bound tries once more before it lets a send go", async () => {
    const vault = new FakeVault({ A: "alpha-secret-1" });
    vault.listError = unavailable;
    const notices = new Notices();
    const scrubber = following(vault, notices);
    scrubber.start();
    expect(await scrubber.ready()).toBe(false);
    later(MAX_SERVER_HOLD_MS);
    expect(await scrubber.ready()).toBe(true);
    const released = () => log.filter((line) => line.startsWith("vault scrubber: the vault has failed to read")).length;
    expect(released()).toBe(1);
    // Released: a send doesn't read the vault first.
    const lists = vault.lists;
    expect(await scrubber.ready()).toBe(true);
    expect(vault.lists).toBe(lists);

    notices.write();
    expect(await scrubber.ready()).toBe(true);
    expect(vault.lists).toBe(lists + 1);
    expect(released()).toBe(2);

    // Answered: that read decides.
    vault.listError = null;
    vault.secrets.B = "bravo-secret-2";
    notices.write();
    expect(await scrubber.ready()).toBe(true);
    expect(vault.lists).toBe(lists + 2);
    expect(scrubber.scrub("bravo-secret-2").text).toBe("[VAULT:B]");
  });

  it("a key that couldn't be read (engram#677), readable when the notice comes: one read covers both", async () => {
    const vault = new FakeVault({ A: "alpha-secret-1" });
    const notices = new Notices();
    let key: string | Error = new VaultKeyUnreadable("is a folder, not a file", "folder");
    const source: VaultKeySource = {
      read: async () => {
        if (key instanceof Error) throw key;
        return key;
      },
      vaultWith: () => vault,
    };
    const scrubber = following(null, notices, { source, problem: key });
    scrubber.start();
    expect(await scrubber.ready()).toBe(false);

    vault.secrets.B = "bravo-secret-2";
    notices.write();
    key = KEY;
    later(READ_RETRY_MS[0]);
    expect(await scrubber.ready()).toBe(true);
    expect(vault.lists).toBe(1);
    expect(scrubber.scrub("bravo-secret-2").text).toBe("[VAULT:B]");
  });

  it("stopped, it reads the vault no more", async () => {
    const vault = new FakeVault({ A: "alpha-secret-1" });
    const notices = new Notices();
    const scrubber = following(vault, notices);
    vault.hold();
    scrubber.start();
    await settle();
    notices.write();
    void scrubber.ready();
    await settle();

    scrubber.stop();
    vault.release();
    await settle();
    expect(vault.lists).toBe(1);
    expect(await scrubber.ready()).toBe(false);
    expect(vault.lists).toBe(1);
  });
});

describe("~/.engram/vault-changed (engram#701)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engram-701-"));
    log = [];
  });

  afterEach(() => {
    for (const scrubber of scrubbers) scrubber.stop();
    scrubbers = [];
    rmSync(dir, { recursive: true, force: true });
  });

  it("is in ~/.engram", () => {
    expect(VAULT_CHANGED_FILE).toBe(join(ENGRAM, "vault-changed"));
  });

  it("each write is a new notice, the same millisecond too, in a file only its owner reads", () => {
    const file = join(dir, "vault-changed");
    expect(readVaultChanged(file)).toBeNull();
    expect(noteVaultChanged(file)).toBe(true);
    const first = readVaultChanged(file);
    expect(first).not.toBeNull();
    expect(readVaultChanged(file)).toBe(first);
    expect(readFileSync(file, "utf-8")).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z [0-9a-f]{16}\n$/);
    if (posix) expect(statSync(file).mode & 0o777).toBe(0o600);

    const seen = new Set([first]);
    for (let i = 0; i < 5; i++) {
      expect(noteVaultChanged(file)).toBe(true);
      seen.add(readVaultChanged(file));
    }
    expect(seen.size).toBe(6);
    expect(readdirSync(dir)).toEqual(["vault-changed"]);
  });

  it("is what the file says: touched, or put back as it was, it is the same notice", () => {
    const file = join(dir, "vault-changed");
    expect(noteVaultChanged(file)).toBe(true);
    const first = readVaultChanged(file);
    const said = readFileSync(file);
    utimesSync(file, new Date(2030, 0, 1), new Date(2030, 0, 1));
    expect(readVaultChanged(file)).toBe(first);
    rmSync(file);
    writeFileSync(file, said);
    expect(readVaultChanged(file)).toBe(first);
  });

  it("has nowhere to go without ~/.engram, and doesn't make it", () => {
    const missing = join(dir, "missing");
    expect(noteVaultChanged(join(missing, "vault-changed"))).toBe(false);
    expect(existsSync(missing)).toBe(false);
  });

  it("isn't one unless it is a file of 256 bytes at most", () => {
    const file = join(dir, "vault-changed");
    mkdirSync(file);
    expect(readVaultChanged(file)).toBeNull();
    expect(noteVaultChanged(file)).toBe(false);
    rmSync(file, { recursive: true });
    writeFileSync(file, "x".repeat(256));
    expect(readVaultChanged(file)).not.toBeNull();
    writeFileSync(file, "x".repeat(257));
    expect(readVaultChanged(file)).toBeNull();
  });

  posixIt("isn't one when it is a FIFO, and reading it doesn't wait for a writer", () => {
    const file = join(dir, "vault-changed");
    execFileSync("mkfifo", [file]);
    expect(readVaultChanged(file)).toBeNull();
  });

  it("has the daemon read the vault for each `vault set`, the same millisecond too", async () => {
    const file = join(dir, "vault-changed");
    const vault = new FakeVault({ A: "alpha-secret-1" });
    const scrubber = new SecretScrubber(vault, KEY);
    scrubbers.push(scrubber);
    scrubber.followChanges(() => readVaultChanged(file));
    scrubber.start();
    expect(await scrubber.ready()).toBe(true);
    for (let lists = 2; lists <= 4; lists++) {
      expect(noteVaultChanged(file)).toBe(true);
      expect(await scrubber.ready()).toBe(true);
      expect(vault.lists).toBe(lists);
    }
    expect(await scrubber.ready()).toBe(true);
    expect(vault.lists).toBe(4);
  });
});

/** `server` listening where the daemon does. Returns how to stop it, and close what it holds open. */
async function onDaemonEndpoint(server: Server): Promise<() => Promise<void>> {
  const endpoint = daemonEndpoint();
  if ("unavailable" in endpoint) throw new Error(endpoint.unavailable);
  const open = new Set<Socket>();
  server.on("connection", (socket) => {
    socket.on("error", () => {});
    open.add(socket);
    socket.on("close", () => open.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint.path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return () =>
    new Promise<void>((resolve) => {
      for (const socket of open) socket.destroy();
      server.close(() => resolve());
    });
}

/**
 * A daemon answering on its socket. `notices`: one that reads the vault
 * again when told it changed; without it, one from before. Returns how to
 * stop it.
 */
function daemonAnswering({ stopping = false, notices = false } = {}): Promise<() => Promise<void>> {
  const answer = {
    engram: "daemon",
    protocol: 1,
    pid: 4242,
    ready: true,
    stopping,
    stop_file: true,
    vault_key_reread: true,
  };
  const line = `${JSON.stringify(notices ? { ...answer, vault_change_notice: true } : answer)}\n`;
  return onDaemonEndpoint(createServer((socket) => socket.end(line)));
}

/** A daemon too busy to answer, as in its first start after an update. */
function daemonBusy(): Promise<() => Promise<void>> {
  return onDaemonEndpoint(createServer(() => {}));
}

describe("engram vault set and delete tell the daemon running now (engram#701)", () => {
  const STORED = ["Secret stored: B", "Encrypted client-side. The server never sees the plaintext value."];
  const BEFORE = [
    "The daemon running now reads the vault every 10 minutes, and may send this secret unscrubbed until then.",
    "To have it scrubbed from now on, run 'engram stop', then 'engram start'.",
  ];
  const NOT_TOLD = "Couldn't write ~/.engram/vault-changed to tell the daemon running now.";

  let out: string[];
  let errs: string[];

  beforeEach(() => {
    rmSync(ENGRAM, { recursive: true, force: true });
    mkdirSync(ENGRAM, { mode: 0o700 });
    pidFileDaemon.pid = null;
    out = [];
    errs = [];
    vi.stubEnv("NO_COLOR", "1");
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void out.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errs.push(args.join(" ")));
    // Exiting stops the command, as it does.
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
  });

  afterEach(() => {
    pidFileDaemon.pid = null;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  /** A client whose vault requests the test decides. */
  function client(vault: { set?: () => Promise<void>; delete?: () => Promise<boolean> } = {}): Engram {
    return {
      vault: { set: async () => {}, delete: async () => true, ...vault },
    } as unknown as Engram;
  }

  /** What `engram vault set B …` says, with `daemon` running. */
  async function set(
    daemon: () => Promise<() => Promise<void>> = async () => async () => {},
    using: Engram = client(),
  ): Promise<string[]> {
    out = [];
    const stop = await daemon();
    try {
      await vaultSet(using, ["B", "bravo-secret-2"], {});
    } finally {
      await stop();
    }
    return out;
  }

  it("one that reads the vault when told: told, and nothing more to say", async () => {
    expect(readVaultChanged()).toBeNull();
    expect(await set(() => daemonAnswering({ notices: true }))).toEqual(STORED);
    const told = readVaultChanged();
    expect(told).not.toBeNull();
    // Each `vault set` is a new notice.
    expect(await set(() => daemonAnswering({ notices: true }))).toEqual(STORED);
    expect(readVaultChanged()).not.toBe(told);
  });

  it("one from before, or one that doesn't say which it is: how to have the secret scrubbed now", async () => {
    expect(await set(() => daemonAnswering())).toEqual([...STORED, ...BEFORE]);
    expect(await set(daemonBusy)).toEqual([...STORED, ...BEFORE]);
    pidFileDaemon.pid = 4242;
    expect(await set()).toEqual([...STORED, ...BEFORE]);
    // Told all the same: one too busy to say may read notices.
    expect(readVaultChanged()).not.toBeNull();
  });

  it("the notice couldn't be written: says so, and how to have the secret scrubbed now", async () => {
    mkdirSync(VAULT_CHANGED_FILE);
    expect(await set(() => daemonAnswering({ notices: true }))).toEqual([...STORED, NOT_TOLD, ...BEFORE]);
  });

  it("none running, or one stopping: nothing about it", async () => {
    expect(await set()).toEqual(STORED);
    expect(await set(() => daemonAnswering({ stopping: true }))).toEqual(STORED);
    // There is a notice, for a daemon started before it is read.
    expect(readVaultChanged()).not.toBeNull();
  });

  it("a request that failed may have saved the secret still: the daemon is told", async () => {
    const failing = client({
      set: async () => {
        throw offline();
      },
    });
    await expect(set(() => daemonAnswering({ notices: true }), failing)).rejects.toThrow("Network error");
    expect(readVaultChanged()).not.toBeNull();
    expect(out).toEqual([]);
  });

  it("vault delete tells it too, unless there was nothing to delete", async () => {
    await vaultDelete(client(), ["B"], {});
    expect(out).toEqual(["Deleted: B"]);
    expect(readVaultChanged()).not.toBeNull();

    rmSync(VAULT_CHANGED_FILE);
    await expect(vaultDelete(client({ delete: async () => false }), ["B"], {})).rejects.toThrow("exit 1");
    expect(errs).toEqual(['Secret "B" not found.']);
    expect(readVaultChanged()).toBeNull();

    // Cut short, it may have deleted it still.
    const failing = client({
      delete: async () => {
        throw offline();
      },
    });
    await expect(vaultDelete(failing, ["B"], {})).rejects.toThrow("Network error");
    expect(readVaultChanged()).not.toBeNull();
  });
});
