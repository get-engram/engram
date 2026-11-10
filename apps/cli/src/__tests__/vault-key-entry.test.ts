import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
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

const { home, clients, stored, requests, captureTurnedOn } = vi.hoisted(() => ({
  home: { dir: "" },
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
vi.mock("@getengram/sdk", () => ({
  Engram: class {
    vault = { list: async () => [] };
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
});
