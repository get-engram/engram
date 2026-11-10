import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngramError } from "@getengram/sdk";

/**
 * engram#677 — the commands that use the vault key, run as `engram
 * <command>` does, while ~/.engram/vault-key is there but can't be read.
 * They stop before they make a client: without the key, store and import
 * would send the vault's secrets as they are. The commands that don't use
 * the key run as before, ENGRAM_VAULT_KEY still wins over the file, and a
 * file that isn't there still means no vault. Also the banner said before
 * each command while the daemon holds messages for the key. The SDK, fetch
 * and turning capture on are faked, nothing here looks for a daemon, and
 * the home directory is a temp dir.
 */

const { home, clients, stored, requests, captureTurnedOn, vault } = vi.hoisted(() => ({
  home: { dir: "" },
  /**
   * The vault the fake client reads (engram#694): what list() gives, what
   * reading each secret gives or throws (unsaid: null, not found), what
   * list() throws, and each secret read.
   */
  vault: {
    secrets: [] as Array<{ name: string; secretType: string; updatedAt: string }>,
    reads: {} as Record<string, string | Error>,
    listError: null as Error | null,
    got: [] as string[],
  },
  /** Every SDK client made: its server, its key, and the vault key it was given. */
  clients: [] as Array<{ baseUrl: string | undefined; apiKey: string; vaultKey: string | undefined }>,
  /** What the store command sent. */
  stored: [] as Array<{ conversationId: string; contents: string[] }>,
  requests: [] as string[],
  captureTurnedOn: { times: 0 },
}));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));
// Everything in ~/.engram is the user's (engram#659 has the rest).
vi.mock("../daemon/ownership.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/ownership.js")>()),
  foreignFiles: () => null,
}));
vi.mock("../daemon/index.js", () => ({
  daemonStart: async () => {},
  daemonStop: async () => {},
  daemonStatus: async () => {},
  daemonInstall: async () => {},
  daemonUninstall: async () => {},
}));
// The last thing the entry does after these commands: the sign it's done.
vi.mock("../daemon/commands.js", () => ({
  autoEnableCapture: async () => void (captureTurnedOn.times += 1),
}));
vi.mock("@getengram/sdk", async (importOriginal) => ({
  // The key `vault keygen` makes, and the errors: the real ones, which
  // reach nothing.
  ...(await importOriginal<typeof import("@getengram/sdk")>()),
  Engram: class {
    vault = {
      list: async () => {
        if (vault.listError) throw vault.listError;
        return vault.secrets.map((secret) => ({ ...secret }));
      },
      get: async (name: string) => {
        vault.got.push(name);
        const read = vault.reads[name];
        if (read instanceof Error) throw read;
        return read ?? null;
      },
    };
    constructor(config: { apiKey: string; baseUrl?: string; vault?: { encryptionKey: string } }) {
      clients.push({ baseUrl: config.baseUrl, apiKey: config.apiKey, vaultKey: config.vault?.encryptionKey });
    }
    async search() {
      return { total: 0, results: [] };
    }
    async store(input: { conversationId: string; messages: Array<{ content: string }> }) {
      stored.push({ conversationId: input.conversationId, contents: input.messages.map((m) => m.content) });
      return { appended: input.messages.length, messageIds: ["msg_677"] };
    }
  },
}));

home.dir = mkdtempSync(join(tmpdir(), "engram-677-entry-"));
afterAll(() => rmSync(home.dir, { recursive: true, force: true }));

const ENGRAM_DIR = join(home.dir, ".engram");
const CONFIG_FILE = join(ENGRAM_DIR, "config.json");
const KEY_FILE = join(ENGRAM_DIR, "vault-key");
const STATUS_FILE = join(ENGRAM_DIR, "status.json");
const PID_FILE = join(ENGRAM_DIR, "daemon.pid");
const FILE_KEY = "engram_sk_live_test_677_file_2468024680";
const ENV_API_KEY = "engram_sk_live_test_694_env_1357913579";
const SERVER = "http://127.0.0.1:8788";
/** Vault keys: 32 bytes, base64. */
const VAULT_KEY = Buffer.alloc(32, 7).toString("base64");
const ENV_VAULT_KEY = Buffer.alloc(32, 9).toString("base64");

const posix = process.platform !== "win32";
const root = process.getuid?.() === 0;
/** Mode 000 stops no one as root, and isn't a thing on Windows. */
const unreadableIt = it.skipIf(!posix || root);
/** Making a symlink on Windows takes a privilege a test can't count on. */
const posixIt = it.skipIf(!posix);

/** Said by a command that needs the key, which stops. */
const refusal = (problem: string, fix: string) => [
  `Error: ~/.engram/vault-key ${problem}, so Engram can't use your vault key. Nothing was sent.`,
  `  ${fix}`,
  "  Then run this again.",
];
const FOLDER_REFUSAL = refusal(
  "is a folder, not a file",
  "Move the folder aside, and put your vault key back in ~/.engram/vault-key.",
);
/** Said before each command while the daemon holds messages for the key. */
const banner = (waiting: number) => [
  "engram: Your vault key (~/.engram/vault-key) can't be read, so messages wait here rather than " +
    `be sent with your vault's secrets in them. Nothing is lost. ${waiting} messages waiting locally.`,
  "  (run 'engram status' for details)",
  "",
];

/** A folder where the key should be, with something in it to keep. */
function keyFolder(): void {
  mkdirSync(KEY_FILE);
  writeFileSync(join(KEY_FILE, "kept"), "kept");
}

describe("commands that use the vault key, with a key file that can't be read (engram#677)", () => {
  const argv = process.argv;
  let out: string[];
  let errs: string[];
  /** Each exit asked for, and how many lines were said on stderr by then. */
  let exits: Array<{ code: number | undefined; said: number }>;

  beforeEach(() => {
    out = [];
    errs = [];
    exits = [];
    clients.length = 0;
    stored.length = 0;
    requests.length = 0;
    captureTurnedOn.times = 0;
    vault.secrets = [];
    vault.reads = {};
    vault.listError = null;
    vault.got = [];
    rmSync(ENGRAM_DIR, { recursive: true, force: true });
    mkdirSync(ENGRAM_DIR, { mode: 0o700 });
    writeFileSync(CONFIG_FILE, JSON.stringify({ apiKey: FILE_KEY, baseUrl: `${SERVER}/` }));
    vi.stubEnv("NO_COLOR", "1");
    vi.stubEnv("ENGRAM_API_KEY", undefined);
    vi.stubEnv("ENGRAM_BASE_URL", undefined);
    vi.stubEnv("ENGRAM_VAULT_KEY", undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        requests.push(String(input));
        throw new Error("no requests in these tests");
      }),
    );
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void out.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errs.push(args.join(" ")));
    // The first exit stops the command, as exiting does. The entry catches
    // that and exits again, which only records: a throw there would leave
    // main() rejected with no one to catch it.
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exits.push({ code, said: errs.length });
      if (exits.length === 1) throw new Error(`exit ${code}`);
    }) as never);
  });

  afterEach(() => {
    process.argv = argv;
    process.exitCode = undefined;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    // So the next test can clear it away.
    try {
      if (lstatSync(KEY_FILE).isFile()) chmodSync(KEY_FILE, 0o600);
    } catch {
      // not there
    }
  });

  /** `engram <words>`: the entry runs its command as it is imported. */
  async function engram(...words: string[]): Promise<void> {
    // Each waits for its own: a test may run two.
    captureTurnedOn.times = 0;
    process.argv = [argv[0], "engram", ...words];
    vi.resetModules();
    await import("../index.js");
    await vi.waitFor(() => expect(captureTurnedOn.times).toBe(1), { timeout: 5_000 });
  }

  /** What was said on stderr before the first exit. */
  const saidBeforeExiting = () => errs.slice(0, exits[0]?.said ?? errs.length);

  it.each([
    "store -c conv_1 hello",
    "append -c conv_1 hello",
    "import",
    "vault list",
    "vault get NAME",
    "vault set NAME --value v",
    "vault delete NAME",
  ])("engram %s stops before making a client while the key file is a folder", async (command) => {
    keyFolder();
    await engram(...command.split(" "));
    expect(exits[0]?.code).toBe(1);
    expect(saidBeforeExiting()).toEqual(FOLDER_REFUSAL);
    expect(clients).toEqual([]);
    expect(stored).toEqual([]);
    expect(requests).toEqual([]);
    expect(out).toEqual([]);
    // The folder is left as it was.
    expect(readdirSync(KEY_FILE)).toEqual(["kept"]);
  });

  unreadableIt("a key file it can't read (mode 000): says how to make it readable, and keeps it", async () => {
    writeFileSync(KEY_FILE, `${VAULT_KEY}\n`);
    chmodSync(KEY_FILE, 0o000);
    await engram("store", "-c", "conv_1", "hello");
    expect(exits[0]?.code).toBe(1);
    expect(saidBeforeExiting()).toEqual(
      refusal("can't be read: permission denied", "Make it readable with: chmod 600 ~/.engram/vault-key"),
    );
    expect(clients).toEqual([]);
    expect(stored).toEqual([]);
    expect(lstatSync(KEY_FILE).mode & 0o777).toBe(0);
    chmodSync(KEY_FILE, 0o600);
    expect(readFileSync(KEY_FILE, "utf-8")).toBe(`${VAULT_KEY}\n`);
  });

  posixIt("a link to a file that isn't there: the drive may just be unplugged, so it isn't taken for no key", async () => {
    const target = join(home.dir, "unplugged", "vault-key");
    symlinkSync(target, KEY_FILE);
    await engram("import");
    expect(exits[0]?.code).toBe(1);
    expect(saidBeforeExiting()).toEqual(
      refusal(
        "is a link to a file that isn't there",
        "Connect the drive the link points to again, or put your vault key in its place.",
      ),
    );
    expect(clients).toEqual([]);
    expect(readlinkSync(KEY_FILE)).toBe(target);
  });

  it("an empty key file: a key that was there may be lost, so it isn't taken for no key", async () => {
    writeFileSync(KEY_FILE, " \n");
    await engram("vault", "set", "NAME", "--value", "v");
    expect(exits[0]?.code).toBe(1);
    expect(saidBeforeExiting()).toEqual(
      refusal("is empty", "Put your vault key back in it. If you don't use the vault, delete the empty file."),
    );
    expect(clients).toEqual([]);
    expect(readFileSync(KEY_FILE, "utf-8")).toBe(" \n");
  });

  it("commands that don't use the key run as before", async () => {
    keyFolder();
    await engram("search", "foo");
    expect(exits).toEqual([]);
    expect(clients).toEqual([{ baseUrl: SERVER, apiKey: FILE_KEY, vaultKey: undefined }]);
    expect(out).toEqual(["No results found."]);
    expect(errs).toEqual([]);
  });

  it("ENGRAM_VAULT_KEY still wins over the file: the command runs with it", async () => {
    keyFolder();
    vi.stubEnv("ENGRAM_VAULT_KEY", ENV_VAULT_KEY);
    await engram("store", "-c", "conv_1", "hello");
    expect(exits).toEqual([]);
    expect(clients).toEqual([{ baseUrl: SERVER, apiKey: FILE_KEY, vaultKey: ENV_VAULT_KEY }]);
    expect(stored).toEqual([{ conversationId: "conv_1", contents: ["hello"] }]);
    expect(out).toEqual(["✓ Stored 1 message", "  IDs: msg_677"]);
    expect(errs).toEqual([]);
    expect([...out, ...errs].join("\n")).not.toContain(ENV_VAULT_KEY);
  });

  it("no key file still means no vault: store sends without one", async () => {
    await engram("store", "-c", "conv_1", "hello");
    expect(exits).toEqual([]);
    expect(clients).toEqual([{ baseUrl: SERVER, apiKey: FILE_KEY, vaultKey: undefined }]);
    expect(stored).toEqual([{ conversationId: "conv_1", contents: ["hello"] }]);
    expect(errs).toEqual([]);
  });

  it("no ~/.engram at all still means no vault", async () => {
    rmSync(ENGRAM_DIR, { recursive: true, force: true });
    // Signed in from the environment, so there's no config.json to need.
    vi.stubEnv("ENGRAM_API_KEY", FILE_KEY);
    vi.stubEnv("ENGRAM_BASE_URL", SERVER);
    await engram("vault", "list");
    expect(exits).toEqual([]);
    expect(clients).toEqual([{ baseUrl: SERVER, apiKey: FILE_KEY, vaultKey: undefined }]);
    expect(requests).toEqual([]);
    expect(out).toEqual(["No secrets stored.", "Run 'engram vault set <NAME> <value>' to store one."]);
  });

  it("a key that reads: the client gets it, trimmed", async () => {
    writeFileSync(KEY_FILE, `  ${VAULT_KEY}\n`);
    await engram("vault", "list");
    expect(exits).toEqual([]);
    expect(clients).toEqual([{ baseUrl: SERVER, apiKey: FILE_KEY, vaultKey: VAULT_KEY }]);
    expect([...out, ...errs].join("\n")).not.toContain(VAULT_KEY);
  });

  it("engram vault save-key saves ENGRAM_VAULT_KEY in the file, for the daemon started at login (engram#690)", async () => {
    vi.stubEnv("ENGRAM_VAULT_KEY", ENV_VAULT_KEY);
    await engram("vault", "save-key");
    expect(exits).toEqual([]);
    expect(readFileSync(KEY_FILE, "utf-8")).toBe(`${ENV_VAULT_KEY}\n`);
    expect(out).toEqual([
      `Vault key saved to: ${KEY_FILE}`,
      "Permissions set to owner-only (600). The daemon started at login reads it there.",
    ]);
    expect(errs).toEqual([]);
    expect(clients).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("engram vault save-key doesn't replace a key file it can't read, --force or not (engram#690)", async () => {
    keyFolder();
    vi.stubEnv("ENGRAM_VAULT_KEY", ENV_VAULT_KEY);
    await engram("vault", "save-key", "--force");
    expect(exits[0]?.code).toBe(1);
    expect(saidBeforeExiting()).toEqual([
      "Error: ~/.engram/vault-key is a folder, not a file, so it can't be backed up, and isn't replaced.",
      "  Move the folder aside, and put your vault key back in ~/.engram/vault-key.",
      "  Then run this again. Or move it aside yourself:",
      "    mv ~/.engram/vault-key ~/.engram/vault-key.old",
    ]);
    expect(readdirSync(KEY_FILE)).toEqual(["kept"]);
    expect(out).toEqual([]);
    expect([...out, ...errs].join("\n")).not.toContain(ENV_VAULT_KEY.slice(0, 8));
  });

  describe("the banner, while the daemon holds messages for the key", () => {
    beforeEach(() => {
      writeFileSync(STATUS_FILE, JSON.stringify({ error_type: "vault_key", pending_messages: 3 }));
    });

    it("is said before the command while the file can't be read", async () => {
      keyFolder();
      await engram("search", "foo");
      expect(exits).toEqual([]);
      expect(errs).toEqual(banner(3));
      expect(out).toEqual(["No results found."]);
    });

    it("comes before the refusal of a command that needs the key", async () => {
      keyFolder();
      await engram("store", "-c", "conv_1", "hello");
      expect(exits[0]?.code).toBe(1);
      expect(saidBeforeExiting()).toEqual([...banner(3), ...FOLDER_REFUSAL]);
      expect(stored).toEqual([]);
    });

    it("isn't said once the file reads fine: the daemon reads it again on its own", async () => {
      writeFileSync(KEY_FILE, `${VAULT_KEY}\n`);
      await engram("search", "foo");
      expect(errs).toEqual([]);
    });

    it("is said while the file is gone and the daemon runs: it still holds them", async () => {
      // A process that runs: this one.
      writeFileSync(PID_FILE, `${process.pid}\n`);
      await engram("search", "foo");
      expect(errs).toEqual(banner(3));
    });

    it("isn't said once the file is gone and no daemon runs: the next starts without a key, and sends them", async () => {
      // As after 'engram stop', which is how to go on without a key: no
      // daemon.pid. The start after it would say they wait, as they go
      // (scripts/e2e-vault-key.mjs runs that start).
      await engram("search", "foo");
      expect(errs).toEqual([]);
      expect(out).toEqual(["No results found."]);
    });

    it("is said with ENGRAM_VAULT_KEY set: the daemon reads the file, not this shell's key", async () => {
      keyFolder();
      vi.stubEnv("ENGRAM_VAULT_KEY", ENV_VAULT_KEY);
      await engram("search", "foo");
      expect(errs).toEqual(banner(3));
    });
  });

  describe("the banner, while the daemon holds sends for a key that decrypts none of the vault's secrets (engram#694)", () => {
    const mismatchBanner = (waiting: number) => [
      "engram: Your vault holds secrets your vault key doesn't decrypt, so messages wait here rather than " +
        `be sent with those secrets in them. Nothing is lost. ${waiting} messages waiting locally.`,
      "  (run 'engram status' for details)",
      "",
    ];

    beforeEach(() => {
      writeFileSync(
        STATUS_FILE,
        JSON.stringify({
          health: "error",
          error_type: "vault_mismatch",
          pending_messages: 3,
          vault_undecryptable: { secrets: 2, unscrubbed: 2, decrypted: 0, held: true },
        }),
      );
    });

    it("is said before the command, though the key file reads: it is the key that doesn't match", async () => {
      writeFileSync(KEY_FILE, `${VAULT_KEY}\n`);
      await engram("search", "foo");
      expect(exits).toEqual([]);
      expect(errs).toEqual(mismatchBanner(3));
      expect(out).toEqual(["No results found."]);
    });

    it("doesn't stop a command that uses the key, which reads", async () => {
      writeFileSync(KEY_FILE, `${VAULT_KEY}\n`);
      await engram("store", "-c", "conv_1", "hello");
      expect(exits).toEqual([]);
      expect(errs).toEqual(mismatchBanner(3));
      expect(stored).toEqual([{ conversationId: "conv_1", contents: ["hello"] }]);
    });

    it("is said with no key file while the daemon runs: it holds them still", async () => {
      // A process that runs: this one.
      writeFileSync(PID_FILE, `${process.pid}\n`);
      await engram("search", "foo");
      expect(errs).toEqual(mismatchBanner(3));
    });

    it("isn't said with no key file and no daemon: the next starts without a key", async () => {
      await engram("search", "foo");
      expect(errs).toEqual([]);
    });

    it("isn't said for a key that decrypts some of them: sending goes on", async () => {
      writeFileSync(KEY_FILE, `${VAULT_KEY}\n`);
      writeFileSync(
        STATUS_FILE,
        JSON.stringify({ health: "healthy", pending_messages: 0, vault_undecryptable: { secrets: 1, unscrubbed: 1 } }),
      );
      await engram("search", "foo");
      expect(errs).toEqual([]);
    });
  });

  const SAVED_AT = "2026-11-01T00:00:00.000Z";
  /** What the SDK throws when a request doesn't get there. */
  const offline = () => new EngramError("Network error: fetch failed");
  /** The vault holds secrets by these names. */
  const holds = (...names: string[]) =>
    void (vault.secrets = names.map((name) => ({ name, secretType: "api_key", updatedAt: SAVED_AT })));

  describe("engram vault keygen --save, with no key saved, over secrets the vault holds already (engram#694)", () => {
    /** Said as it refuses: `one` secret or two. */
    const refused = (one: boolean, haveIt: string) => [
      `Your vault holds ${one ? "1 secret" : "2 secrets"}, saved with another vault key.`,
      `A new key can't decrypt ${one ? "it" : "them"}, so the daemon would hold what it captures`,
      `rather than send it with ${one ? "that secret" : "those secrets"} in it. The key wasn't saved.`,
      haveIt,
      "  To make a new key all the same: engram vault keygen --save --force. Then save",
      one
        ? "  the secret again with it (engram vault set <NAME>), or delete it if you no"
        : "  each secret again with it (engram vault set <NAME>), or delete each you no",
      `  longer use${one ? " it" : ""} (engram vault delete <NAME>).`,
    ];
    const HAVE_IT = "  If you have that key, put it in ~/.engram/vault-key.";

    it("refuses: none of them would decrypt with the new key, so the daemon would hold what it captures", async () => {
      holds("A", "B");
      await engram("vault", "keygen", "--save");
      expect(exits[0]?.code).toBe(1);
      expect(saidBeforeExiting()).toEqual(refused(false, HAVE_IT));
      expect(existsSync(KEY_FILE)).toBe(false);
      // Asked with the key it made, of the account's own server: a list,
      // which decrypts nothing, and no secret read.
      expect(clients).toEqual([{ baseUrl: SERVER, apiKey: FILE_KEY, vaultKey: expect.any(String) }]);
      expect(vault.got).toEqual([]);
      expect(out).toEqual([]);
      expect(requests).toEqual([]);
    });

    it("one secret: said of it", async () => {
      holds("A");
      await engram("vault", "keygen", "--save");
      expect(exits[0]?.code).toBe(1);
      expect(saidBeforeExiting()).toEqual(refused(true, HAVE_IT));
    });

    it("with ENGRAM_VAULT_KEY set and no key file: it may be the key, and how to save it", async () => {
      holds("A", "B");
      vi.stubEnv("ENGRAM_VAULT_KEY", ENV_VAULT_KEY);
      await engram("vault", "keygen", "--save");
      expect(exits[0]?.code).toBe(1);
      expect(saidBeforeExiting()).toEqual(
        refused(false, "  ENGRAM_VAULT_KEY holds a key. If it's that one, save it: engram vault save-key"),
      );
      expect(existsSync(KEY_FILE)).toBe(false);
      expect([...out, ...errs].join("\n")).not.toContain(ENV_VAULT_KEY.slice(0, 8));
    });

    it("--force: saved, with no check", async () => {
      holds("A", "B");
      await engram("vault", "keygen", "--save", "--force");
      expect(exits).toEqual([]);
      expect(readFileSync(KEY_FILE, "utf-8")).toMatch(/^[A-Za-z0-9+/]{43}=\n$/);
      expect(clients).toEqual([]);
    });

    it("an empty vault: saved, and nothing said of it", async () => {
      await engram("vault", "keygen", "--save");
      expect(exits).toEqual([]);
      expect(clients).toHaveLength(1);
      expect(readFileSync(KEY_FILE, "utf-8")).toMatch(/^[A-Za-z0-9+/]{43}=\n$/);
      expect(out.join("\n")).not.toContain("Couldn't check");
      expect(errs).toEqual([]);
    });

    it("signed out: nothing to ask, and saved", async () => {
      writeFileSync(CONFIG_FILE, JSON.stringify({ baseUrl: `${SERVER}/` }));
      await engram("vault", "keygen", "--save");
      expect(exits).toEqual([]);
      expect(clients).toEqual([]);
      expect(existsSync(KEY_FILE)).toBe(true);
    });

    it("a vault that can't be checked: said, and saved", async () => {
      vault.listError = offline();
      await engram("vault", "keygen", "--save");
      expect(exits).toEqual([]);
      expect(out.slice(0, 2)).toEqual([
        "Couldn't check your vault for secrets saved with another key. Any there",
        "don't decrypt with this one: 'engram vault list --check' shows which.",
      ]);
      expect(existsSync(KEY_FILE)).toBe(true);
    });

    it("signed in through ENGRAM_API_KEY: the vault checked is that account's, as each command's is", async () => {
      holds("A", "B");
      vi.stubEnv("ENGRAM_API_KEY", ENV_API_KEY);
      await engram("vault", "keygen", "--save");
      expect(exits[0]?.code).toBe(1);
      expect(saidBeforeExiting()).toEqual(refused(false, HAVE_IT));
      expect(clients).toEqual([{ baseUrl: SERVER, apiKey: ENV_API_KEY, vaultKey: expect.any(String) }]);
      expect(existsSync(KEY_FILE)).toBe(false);
    });

    it("a config.json that can't be read: no account to check, said, and saved", async () => {
      writeFileSync(CONFIG_FILE, "{ not json");
      await engram("vault", "keygen", "--save");
      expect(exits).toEqual([]);
      expect(clients).toEqual([]);
      expect(out.slice(0, 2)).toEqual([
        "Couldn't check your vault for secrets saved with another key. Any there",
        "don't decrypt with this one: 'engram vault list --check' shows which.",
      ]);
      expect(existsSync(KEY_FILE)).toBe(true);
    });

    it("a key saved already: refused as before, with no check", async () => {
      holds("A");
      writeFileSync(KEY_FILE, `${VAULT_KEY}\n`);
      await engram("vault", "keygen", "--save");
      expect(exits[0]?.code).toBe(1);
      expect(saidBeforeExiting()[0]).toBe(`A vault key already exists at ${KEY_FILE}.`);
      expect(readFileSync(KEY_FILE, "utf-8")).toBe(`${VAULT_KEY}\n`);
      expect(clients).toEqual([]);
    });

    it("without --save: printed, with no check", async () => {
      holds("A");
      await engram("vault", "keygen");
      expect(exits).toEqual([]);
      expect(out[0]).toMatch(/^[A-Za-z0-9+/]{43}=$/);
      expect(clients).toEqual([]);
      expect(existsSync(KEY_FILE)).toBe(false);
    });
  });

  describe("engram vault list --check: which of the vault's secrets decrypt with this key (engram#694)", () => {
    const wrongKey = () =>
      new DOMException("The operation failed for an operation-specific reason", "OperationError");

    beforeEach(() => {
      writeFileSync(KEY_FILE, `${VAULT_KEY}\n`);
      vault.secrets = [
        { name: "A", secretType: "api_key", updatedAt: SAVED_AT },
        { name: "B", secretType: "password", updatedAt: SAVED_AT },
        { name: "C", secretType: "api_key", updatedAt: SAVED_AT },
      ];
      vault.reads = { A: "value-of-a-694", B: wrongKey(), C: offline() };
    });

    it("marks each that doesn't decrypt, and each it couldn't check, and never prints a value", async () => {
      await engram("vault", "list", "--check");
      expect(exits).toEqual([]);
      expect(out).toEqual([
        "NAME  TYPE      UPDATED",
        "A     api_key   2026-11-01",
        "B     password  2026-11-01  doesn't decrypt",
        "C     api_key   2026-11-01  couldn't check",
        "",
        "3 secrets",
        "1 of them doesn't decrypt with this vault key: saved with another.",
        // Not putting its key back: the others don't decrypt with that.
        "Save it again with this key",
        "(engram vault set <NAME>), or delete it if you no longer use it (engram vault delete <NAME>).",
        "1 couldn't be checked: run this again.",
      ]);
      expect(vault.got).toEqual(["A", "B", "C"]);
      expect([...out, ...errs].join("\n")).not.toContain("value-of-a-694");
    });

    it("none decrypts: putting their key back is a fix", async () => {
      vault.reads = { A: wrongKey(), B: wrongKey(), C: wrongKey() };
      await engram("vault", "list", "--check");
      expect(out.slice(-3)).toEqual([
        "3 of them don't decrypt with this vault key: saved with another.",
        "Put that key in ~/.engram/vault-key, or save each again with this one",
        "(engram vault set <NAME>), or delete each you no longer use (engram vault delete <NAME>).",
      ]);
    });

    it("each decrypts: said so", async () => {
      vault.reads = { A: "a", B: "b", C: "c" };
      await engram("vault", "list", "--check");
      expect(out.slice(-2)).toEqual(["3 secrets", "Each decrypts with this vault key."]);
      holds("A");
      out = [];
      await engram("vault", "list", "--check");
      expect(out.slice(-2)).toEqual(["1 secret", "It decrypts with this vault key."]);
    });

    it("the others decrypt, one deleted after the list: not said to decrypt, nor not to", async () => {
      vault.reads = { A: "a", B: "b" };
      await engram("vault", "list", "--check");
      expect(out).toEqual([
        "NAME  TYPE      UPDATED",
        "A     api_key   2026-11-01",
        "B     password  2026-11-01",
        "C     api_key   2026-11-01  couldn't check",
        "",
        "3 secrets",
        "1 couldn't be checked: run this again.",
      ]);
    });

    it("its one secret doesn't decrypt: said of it", async () => {
      holds("A");
      vault.reads = { A: wrongKey() };
      await engram("vault", "list", "--check");
      expect(out.slice(-4)).toEqual([
        "1 secret",
        "It doesn't decrypt with this vault key: it was saved with another.",
        "Put that key in ~/.engram/vault-key, or save it again with this one",
        "(engram vault set <NAME>), or delete it if you no longer use it (engram vault delete <NAME>).",
      ]);
    });

    it("--json: whether each decrypts, true, false or null, and never a value", async () => {
      await engram("vault", "list", "--check", "--json");
      expect(JSON.parse(out.join("\n"))).toEqual({
        secrets: [
          { name: "A", secretType: "api_key", updatedAt: SAVED_AT, decrypts: true },
          { name: "B", secretType: "password", updatedAt: SAVED_AT, decrypts: false },
          { name: "C", secretType: "api_key", updatedAt: SAVED_AT, decrypts: null },
        ],
        total: 3,
      });
      expect(out.join("\n")).not.toContain("value-of-a-694");
    });

    it("without --check: no secret is read", async () => {
      await engram("vault", "list");
      expect(out.slice(0, 4)).toEqual([
        "NAME  TYPE      UPDATED",
        "A     api_key   2026-11-01",
        "B     password  2026-11-01",
        "C     api_key   2026-11-01",
      ]);
      out = [];
      await engram("vault", "list", "--json");
      expect(JSON.parse(out.join("\n")).secrets[0]).not.toHaveProperty("decrypts");
      expect(vault.got).toEqual([]);
    });
  });
});
