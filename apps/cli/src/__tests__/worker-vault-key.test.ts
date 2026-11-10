import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * engram#677 — the daemon, started while ~/.engram/vault-key is there but
 * can't be read, starts with sends held: its scrubber waits for the key and
 * reads the file again, and the syncer sends nothing until the scrubber is
 * ready (scrub-before-send.test.ts has that part). It used to take the file
 * for no key, and send the vault's secrets as they were. A file that isn't
 * there is still no key, and ENGRAM_VAULT_KEY still wins over the file.
 *
 * engram#693 — the scrubber reads the key again while the daemon runs, so
 * there is one even with no key yet: a key saved later is read through the
 * account in use. status.json says where the key in use came from.
 *
 * In a temp home, with the lock, the scrubber, the syncer and the SDK's
 * client faked: the worker stops where the syncer would start. Nothing here
 * takes the real daemon's lock, changes the umask of this process, touches
 * the real ~/.engram, or sends anything anywhere.
 */

interface MadeScrubber {
  vault: unknown;
  key: string | undefined;
  /** How it reads the key again, and why it couldn't be read at start. */
  keyFile:
    | {
        problem?: { name: string; kind: string; message: string };
        source: { read(): Promise<string | undefined>; vaultWith(key: string): unknown };
      }
    | undefined;
  started: boolean;
  /** The vault each reconnect was given: after an account switch. */
  reconnects: unknown[];
  /** The scrubber itself, as the syncer gets it. */
  instance: unknown;
  /** Where what each complete read finds goes (engram#694). */
  report: unknown;
  /** What the daemon before held sends for, as handed on, and whether it had started then (engram#694). */
  continued: Array<{ found: unknown; started: boolean }>;
}

/** What a fake client's vault is: what the client was made with. */
interface MadeVault {
  apiKey: string;
  baseUrl: string | undefined;
  vaultKey: string | undefined;
}

/** The syncer's way to switch accounts (KeySource.connect). */
interface Keys {
  connect(account: { key: string; server: string }): unknown;
}

const { home, made } = vi.hoisted(() => ({
  home: { dir: "" },
  made: {
    scrubbers: [] as MadeScrubber[],
    /** The scrubber each syncer was given: what it waits on before sending. */
    syncers: [] as unknown[],
    /** The key source each syncer was given. */
    keys: [] as unknown[],
    /** daemon.db, each time the worker opened it. */
    dbs: [] as { close(): void }[],
  },
}));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));

home.dir = mkdtempSync(join(tmpdir(), "engram-677w-"));
const ENGRAM_DIR = join(home.dir, ".engram");
const KEY_FILE = join(ENGRAM_DIR, "vault-key");

const { START_FAILED_EXIT } = await import("../daemon/supervise.js");

const VAULT_KEY = Buffer.alloc(32, 7).toString("base64");
const ENV_VAULT_KEY = Buffer.alloc(32, 9).toString("base64");
const API_KEY = "engram_sk_live_test_677_worker_1357913579";
const OTHER_API_KEY = "engram_sk_live_test_677_worker_2468024680";
/** Local: no test key is ever named with a server that isn't. */
const SERVER = "http://127.0.0.1:8788";
const posix = process.platform !== "win32";
const root = process.getuid?.() === 0;

/** Where status.json says the daemon's key came from (engram#693). */
function keyOrigin(): unknown {
  const file = join(ENGRAM_DIR, "status.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as { vault_key?: unknown }).vault_key : null;
}

/** What the worker logs, in place of stderr. */
function captureLog(): string[] {
  const written: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  }) as never);
  return written;
}

/** The worker, from its lock (held) to where the syncer would start. */
async function runWorker(): Promise<{ log: () => string }> {
  vi.doMock("../daemon/instance.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../daemon/instance.js")>()),
    claimDaemonLock: vi.fn(async () => ({ state: "held" })),
  }));
  // Everything in ~/.engram is the user's (engram#659 has the rest).
  vi.doMock("../daemon/ownership.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../daemon/ownership.js")>()),
    foreignFiles: vi.fn(() => null),
  }));
  // The worker opens daemon.db, and its fatal path exits without closing it:
  // here it can't exit, so the test closes it. Windows can't delete a file
  // that is open.
  vi.doMock("../daemon/db.js", async (importOriginal) => {
    const real = await importOriginal<typeof import("../daemon/db.js")>();
    return {
      ...real,
      DaemonDb: class extends real.DaemonDb {
        constructor(...args: ConstructorParameters<typeof real.DaemonDb>) {
          super(...args);
          made.dbs.push(this);
        }
      },
    };
  });
  vi.doMock("../daemon/scrubber.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../daemon/scrubber.js")>()),
    SecretScrubber: class {
      private readonly made: MadeScrubber;
      constructor(
        vault: unknown,
        key: string | undefined,
        _log: unknown,
        keyFile?: MadeScrubber["keyFile"],
        report?: unknown,
      ) {
        this.made = { vault, key, keyFile, started: false, reconnects: [], instance: this, report, continued: [] };
        made.scrubbers.push(this.made);
      }
      start() {
        this.made.started = true;
      }
      continueMismatchHold(found: unknown) {
        this.made.continued.push({ found, started: this.made.started });
      }
      reconnect(vault: unknown) {
        this.made.reconnects.push(vault);
        return Promise.resolve();
      }
      stop() {}
    },
  }));
  vi.doMock("../daemon/syncer.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../daemon/syncer.js")>()),
    Syncer: class {
      constructor(_queue: unknown, _client: unknown, scrubber: unknown, keys: unknown) {
        made.syncers.push(scrubber);
        made.keys.push(keys);
        throw new Error("no syncer in this test");
      }
    },
  }));
  // A client is never made for real: its vault says what it was made with.
  vi.doMock("@getengram/sdk", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@getengram/sdk")>()),
    Engram: class {
      readonly vault: MadeVault;
      constructor(config: { apiKey: string; baseUrl?: string; vault?: { encryptionKey: string } }) {
        this.vault = { apiKey: config.apiKey, baseUrl: config.baseUrl, vaultKey: config.vault?.encryptionKey };
      }
    },
  }));
  // The worker's catch exits with START_FAILED_EXIT: let be.
  vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  const written = captureLog();
  await import("../daemon/worker-main.js");
  await vi.waitFor(() => expect(written.join("")).toContain("fatal: "));
  expect(process.exit).toHaveBeenCalledWith(START_FAILED_EXIT);
  // It opened daemon.db once, which afterEach closes.
  expect(made.dbs).toHaveLength(1);
  return { log: () => written.join("") };
}

beforeEach(() => {
  made.scrubbers.length = 0;
  made.syncers.length = 0;
  made.keys.length = 0;
  made.dbs.length = 0;
  mkdirSync(ENGRAM_DIR, { recursive: true, mode: 0o700 });
  // Signed out: no account, so nothing could be sent here anyway.
  vi.stubEnv("ENGRAM_API_KEY", undefined);
  vi.stubEnv("ENGRAM_BASE_URL", undefined);
  vi.stubEnv("ENGRAM_VAULT_KEY", undefined);
  // The worker sets a umask of 0o077: not on this process.
  vi.spyOn(process, "umask").mockReturnValue(0o022);
});

afterEach(() => {
  for (const db of made.dbs.splice(0)) db.close();
  try {
    if (lstatSync(KEY_FILE).isFile()) chmodSync(KEY_FILE, 0o600);
  } catch {
    // not there
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const path of ["instance", "ownership", "db", "scrubber", "syncer"]) vi.doUnmock(`../daemon/${path}.js`);
  vi.doUnmock("@getengram/sdk");
  vi.resetModules();
  rmSync(ENGRAM_DIR, { recursive: true, force: true });
});

afterAll(() => rmSync(home.dir, { recursive: true, force: true }));

describe("a daemon started with a vault key it can't read (engram#677)", () => {
  it("starts with sends held, the scrubber reading the file again, and says why and the fix", async () => {
    mkdirSync(KEY_FILE);
    const { log } = await runWorker();
    expect(made.scrubbers).toHaveLength(1);
    const [scrubber] = made.scrubbers;
    expect(scrubber.vault).toBeNull();
    expect(scrubber.key).toBeUndefined();
    expect(scrubber.started).toBe(true);
    expect(scrubber.keyFile?.problem).toMatchObject({
      name: "VaultKeyUnreadable",
      kind: "folder",
      message: "~/.engram/vault-key is a folder, not a file",
    });
    // The syncer waits on it.
    expect(made.syncers).toEqual([scrubber.instance]);
    // The queue is the temp home's: the worker ran there.
    expect(existsSync(join(ENGRAM_DIR, "daemon.db"))).toBe(true);
    expect(log()).toContain(
      "vault scrubber: holding sends — ~/.engram/vault-key is a folder, not a file. Capture goes on, " +
        "and what it captures is sent once the key can be read. " +
        "Move the folder aside, and put your vault key back in ~/.engram/vault-key.\n",
    );
    expect(log()).not.toContain("vault scrubber: off");

    // What it reads again is the file: still a folder, then a key.
    await expect(scrubber.keyFile?.source.read()).rejects.toMatchObject({ kind: "folder" });
    rmSync(KEY_FILE, { recursive: true });
    writeFileSync(KEY_FILE, `${VAULT_KEY}\n`);
    await expect(scrubber.keyFile?.source.read()).resolves.toBe(VAULT_KEY);
    // Signed out: no account to read the vault through yet.
    expect(scrubber.keyFile?.source.vaultWith(VAULT_KEY)).toBeNull();
    expect(log()).not.toContain(VAULT_KEY);
  });

  it("signed in: the key, once it reads, is the one the vault is read with, then and after a switch", async () => {
    mkdirSync(KEY_FILE);
    writeFileSync(join(ENGRAM_DIR, "config.json"), JSON.stringify({ apiKey: API_KEY, baseUrl: SERVER }), {
      mode: 0o600,
    });
    const { log } = await runWorker();
    const [scrubber] = made.scrubbers;
    expect(scrubber).toMatchObject({ vault: null, key: undefined, started: true });
    expect(scrubber.keyFile?.problem).toMatchObject({ kind: "folder" });
    const [keys] = made.keys as Keys[];

    // A switch while there is no key: no vault to read yet, and still held.
    keys.connect({ key: OTHER_API_KEY, server: SERVER });
    expect(scrubber.reconnects).toEqual([null]);

    rmSync(KEY_FILE, { recursive: true });
    writeFileSync(KEY_FILE, `${VAULT_KEY}\n`);
    const key = await scrubber.keyFile?.source.read();
    expect(key).toBe(VAULT_KEY);
    // Through the account in use now: the one switched to.
    expect(scrubber.keyFile?.source.vaultWith(VAULT_KEY)).toEqual({
      apiKey: OTHER_API_KEY,
      baseUrl: SERVER,
      vaultKey: VAULT_KEY,
    } satisfies MadeVault);

    // And the next switch reads that account's vault with it too.
    keys.connect({ key: API_KEY, server: SERVER });
    expect(scrubber.reconnects).toEqual([
      null,
      { apiKey: API_KEY, baseUrl: SERVER, vaultKey: VAULT_KEY } satisfies MadeVault,
    ]);
    for (const secret of [VAULT_KEY, API_KEY, OTHER_API_KEY]) expect(log()).not.toContain(secret);
  });

  it.skipIf(!posix || root)("a key file it can't read (mode 000): held, with how to make it readable", async () => {
    writeFileSync(KEY_FILE, `${VAULT_KEY}\n`);
    chmodSync(KEY_FILE, 0o000);
    const { log } = await runWorker();
    expect(made.scrubbers[0]?.keyFile?.problem).toMatchObject({ kind: "permission" });
    expect(log()).toContain(
      "vault scrubber: holding sends — ~/.engram/vault-key can't be read: permission denied. Capture goes on, " +
        "and what it captures is sent once the key can be read. " +
        "Make it readable with: chmod 600 ~/.engram/vault-key\n",
    );
  });

  it("an empty key file: held, not taken for no key", async () => {
    writeFileSync(KEY_FILE, "\n");
    const { log } = await runWorker();
    expect(made.scrubbers[0]?.keyFile?.problem).toMatchObject({ kind: "empty" });
    expect(log()).toContain("vault scrubber: holding sends — ~/.engram/vault-key is empty.");
  });

  it("no key file: off until a key is saved, and nothing held", async () => {
    const { log } = await runWorker();
    // One even with no key (engram#693): it reads the file again.
    expect(made.scrubbers).toHaveLength(1);
    const [scrubber] = made.scrubbers;
    expect(scrubber).toMatchObject({ vault: null, key: undefined, started: true });
    expect(scrubber.keyFile?.problem).toBeUndefined();
    expect(made.syncers).toEqual([scrubber.instance]);
    expect(log()).toContain(
      "vault scrubber: off until a vault key is saved (no vault key configured — only pattern redaction applies)\n",
    );
    expect(log()).not.toContain("holding sends");
    expect(keyOrigin()).toBeNull();

    // A key saved while it runs: read from the file, and in use from then on.
    await expect(scrubber.keyFile?.source.read()).resolves.toBeUndefined();
    writeFileSync(KEY_FILE, `${VAULT_KEY}\n`);
    await expect(scrubber.keyFile?.source.read()).resolves.toBe(VAULT_KEY);
    // Signed out: no account to read the vault through yet.
    expect(scrubber.keyFile?.source.vaultWith(VAULT_KEY)).toBeNull();
    expect(keyOrigin()).toBe("file");
    expect(log()).not.toContain(VAULT_KEY);
  });

  it("no key file, signed in: a key saved later is read through the account in use, then and after a switch", async () => {
    writeFileSync(join(ENGRAM_DIR, "config.json"), JSON.stringify({ apiKey: API_KEY, baseUrl: SERVER }), {
      mode: 0o600,
    });
    const { log } = await runWorker();
    const [scrubber] = made.scrubbers;
    expect(scrubber).toMatchObject({ vault: null, key: undefined, started: true });
    const [keys] = made.keys as Keys[];

    // A switch with no key: no vault to read.
    keys.connect({ key: OTHER_API_KEY, server: SERVER });
    expect(scrubber.reconnects).toEqual([null]);

    writeFileSync(KEY_FILE, `${VAULT_KEY}\n`);
    const key = await scrubber.keyFile?.source.read();
    expect(scrubber.keyFile?.source.vaultWith(key as string)).toEqual({
      apiKey: OTHER_API_KEY,
      baseUrl: SERVER,
      vaultKey: VAULT_KEY,
    } satisfies MadeVault);
    expect(keyOrigin()).toBe("file");

    // The next switch reads that account's vault with the key saved.
    keys.connect({ key: API_KEY, server: SERVER });
    expect(scrubber.reconnects).toEqual([
      null,
      { apiKey: API_KEY, baseUrl: SERVER, vaultKey: VAULT_KEY } satisfies MadeVault,
    ]);
    // Signed out: nothing kept.
    (made.keys[0] as { disconnect(): void }).disconnect();
    expect(scrubber.reconnects.at(-1)).toBeNull();
    for (const secret of [VAULT_KEY, API_KEY, OTHER_API_KEY]) expect(log()).not.toContain(secret);
  });

  it("a key that reads: on, with the key, and it reads the file again", async () => {
    writeFileSync(KEY_FILE, `${VAULT_KEY}\n`);
    const { log } = await runWorker();
    expect(made.scrubbers).toHaveLength(1);
    const [scrubber] = made.scrubbers;
    expect(scrubber).toMatchObject({ key: VAULT_KEY, started: true });
    expect(scrubber.keyFile?.problem).toBeUndefined();
    expect(made.syncers).toEqual([scrubber.instance]);
    expect(log()).toContain("vault scrubber: on (exact-match redaction of named secrets and the vault key)\n");
    expect(log()).not.toContain(VAULT_KEY);
    expect(keyOrigin()).toBe("file");

    // Another key in its place: the one the vault is read with from then on.
    writeFileSync(KEY_FILE, `${ENV_VAULT_KEY}\n`);
    await expect(scrubber.keyFile?.source.read()).resolves.toBe(ENV_VAULT_KEY);
    // The file gone: it says so, and the scrubber keeps the key it has.
    rmSync(KEY_FILE);
    await expect(scrubber.keyFile?.source.read()).resolves.toBeUndefined();
  });

  it("ENGRAM_VAULT_KEY set for the daemon still wins over a file it can't read", async () => {
    mkdirSync(KEY_FILE);
    vi.stubEnv("ENGRAM_VAULT_KEY", ENV_VAULT_KEY);
    const { log } = await runWorker();
    expect(made.scrubbers).toHaveLength(1);
    const [scrubber] = made.scrubbers;
    expect(scrubber).toMatchObject({ key: ENV_VAULT_KEY });
    expect(scrubber.keyFile?.problem).toBeUndefined();
    expect(log()).toContain("vault scrubber: on");
    expect(log()).not.toContain("holding sends");
    expect(log()).not.toContain(ENV_VAULT_KEY);
    // status.json says so: `engram vault save-key` tells the user the file
    // isn't the key this daemon uses.
    expect(keyOrigin()).toBe("env");
    // And what it reads again is the variable, whatever the file is.
    await expect(scrubber.keyFile?.source.read()).resolves.toBe(ENV_VAULT_KEY);
  });
});

describe("a daemon started after one that held sends for secrets its vault key didn't decrypt (engram#694)", () => {
  const STATUS_FILE = join(ENGRAM_DIR, "status.json");
  const HELD = { secrets: 2, unscrubbed: 2, decrypted: 1, held: true };
  /** status.json as the daemon before left it: holding sends for them. */
  const heldBefore = (found: unknown = HELD) =>
    writeFileSync(
      STATUS_FILE,
      JSON.stringify({
        health: "error",
        error_type: "vault_mismatch",
        pending_messages: 3,
        vault_key: "file",
        vault_undecryptable: found,
      }),
    );
  const undecryptable = (): unknown =>
    (JSON.parse(readFileSync(STATUS_FILE, "utf-8")) as { vault_undecryptable?: unknown }).vault_undecryptable;

  it("a key that reads: it goes on holding them from the start, and status.json says so from its first write", async () => {
    writeFileSync(KEY_FILE, `${VAULT_KEY}\n`);
    heldBefore();
    await runWorker();
    const [scrubber] = made.scrubbers;
    // Handed on before it starts: its first read finds the hold in place,
    // so a secret that decrypts now doesn't release the others.
    expect(scrubber.continued).toEqual([{ found: { secrets: 2, unscrubbed: 2, decrypted: 1 }, started: false }]);
    expect(scrubber.started).toBe(true);
    // Its first write didn't drop it: `engram status` says sends wait.
    expect(undecryptable()).toEqual(HELD);
    expect(keyOrigin()).toBe("file");
    // What its reads find goes to status.json: once none can't be scrubbed,
    // nothing more is said of a hold.
    (scrubber.report as (found: unknown) => void)({ secrets: 0, unscrubbed: 0, decrypted: 3, held: false });
    expect(undecryptable()).toBeNull();
  });

  it("the key from ENGRAM_VAULT_KEY, or a key file it can't read: held still", async () => {
    vi.stubEnv("ENGRAM_VAULT_KEY", ENV_VAULT_KEY);
    heldBefore();
    await runWorker();
    expect(made.scrubbers[0]?.continued).toEqual([{ found: { secrets: 2, unscrubbed: 2, decrypted: 1 }, started: false }]);
    expect(undecryptable()).toEqual(HELD);
    expect(keyOrigin()).toBe("env");

    for (const db of made.dbs.splice(0)) db.close();
    vi.unstubAllEnvs();
    vi.stubEnv("ENGRAM_VAULT_KEY", undefined);
    vi.resetModules();
    made.scrubbers.length = 0;
    mkdirSync(KEY_FILE);
    heldBefore();
    await runWorker();
    expect(made.scrubbers[0]?.keyFile?.problem).toMatchObject({ kind: "folder" });
    expect(made.scrubbers[0]?.continued).toEqual([{ found: { secrets: 2, unscrubbed: 2, decrypted: 1 }, started: false }]);
    expect(undecryptable()).toEqual(HELD);
  });

  it("no key at all: it starts without the hold, as with no key", async () => {
    heldBefore();
    await runWorker();
    expect(made.scrubbers[0]?.continued).toEqual([]);
    expect(made.scrubbers[0]).toMatchObject({ key: undefined, started: true });
  });

  it("nothing held before, or a status.json from before engram#694: nothing handed on", async () => {
    writeFileSync(KEY_FILE, `${VAULT_KEY}\n`);
    for (const found of [null, { secrets: 2, unscrubbed: 2 }, { ...HELD, held: false }, { ...HELD, held: "true" }]) {
      for (const db of made.dbs.splice(0)) db.close();
      vi.resetModules();
      made.scrubbers.length = 0;
      heldBefore(found);
      await runWorker();
      expect(made.scrubbers[0]?.continued).toEqual([]);
      expect(made.scrubbers[0]?.started).toBe(true);
    }
  });
});
