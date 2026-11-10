import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * engram#673 — commands that send the API key, run as `engram <command>`
 * does, while ~/.engram/config.json can't be read. The file names the
 * server the key goes to as well as the key, so the command stops before
 * it makes a client: a key in ENGRAM_API_KEY isn't sent to the default
 * server in place of the one in the file. The SDK, fetch and turning
 * capture on are faked, nothing here looks for a daemon, and the home
 * directory is a temp dir.
 */

const { home, clients, requests, captureTurnedOn } = vi.hoisted(() => ({
  home: { dir: "" },
  /** Every SDK client made: the server it was pointed at and its key. */
  clients: [] as Array<{ baseUrl: string | undefined; apiKey: string }>,
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
    constructor(config: { apiKey: string; baseUrl?: string }) {
      clients.push({ baseUrl: config.baseUrl, apiKey: config.apiKey });
    }
    async search() {
      return { total: 0, results: [] };
    }
    async listConversations() {
      return { conversations: [], total: 0 };
    }
  },
}));

home.dir = mkdtempSync(join(tmpdir(), "engram-673-entry-"));
afterAll(() => rmSync(home.dir, { recursive: true, force: true }));

const ENGRAM_DIR = join(home.dir, ".engram");
const CONFIG_FILE = join(ENGRAM_DIR, "config.json");
const TAIL = "Q9Z7LEAK";
/** The file cut short just after the key: JSON.parse's own message quotes the end of the key. */
const BROKEN = `{"apiKey":"engram_sk_live_test_673_${TAIL}","n":x}`;
const FILE_KEY = "engram_sk_live_test_673_file_2468024680";
const ENV_KEY = "engram_sk_live_test_673_env_1357913579";
const SERVER = "http://127.0.0.1:8788";

/** Said before the command: capture waits on the file. */
const BANNER = [
  "engram: ~/.engram/config.json isn't valid JSON, so Engram can't tell which folders you excluded " +
    "from capture. New messages wait until it's fixed; nothing is skipped.",
  "  (run 'engram status' for details)",
  "",
];
/** Said by the command, which stops. */
const REFUSAL = [
  "Error: ~/.engram/config.json isn't valid JSON, so Engram can't tell which account or server to use.",
  "  Fix the file, then run this again.",
];

describe("commands that send the API key, with a config.json that can't be read (engram#673)", () => {
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
    requests.length = 0;
    captureTurnedOn.times = 0;
    rmSync(ENGRAM_DIR, { recursive: true, force: true });
    mkdirSync(ENGRAM_DIR, { mode: 0o700 });
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

  it.each(["search foo", "conversations list", "vault list"])(
    "engram %s with ENGRAM_API_KEY set stops before making a client: the server is in the file",
    async (command) => {
      writeFileSync(CONFIG_FILE, BROKEN);
      vi.stubEnv("ENGRAM_API_KEY", ENV_KEY);
      await engram(...command.split(" "));
      expect(exits[0]?.code).toBe(1);
      expect(saidBeforeExiting()).toEqual([...BANNER, ...REFUSAL]);
      expect(clients).toEqual([]);
      expect(requests).toEqual([]);
      expect(out).toEqual([]);
      expect(readFileSync(CONFIG_FILE, "utf-8")).toBe(BROKEN);
      const said = errs.join("\n");
      for (const secret of [TAIL.slice(-4), ENV_KEY.slice(-10)]) expect(said).not.toContain(secret);
    },
  );

  it("says it's the file, not that no one is signed in, without ENGRAM_API_KEY", async () => {
    writeFileSync(CONFIG_FILE, BROKEN);
    await engram("search", "foo");
    expect(exits[0]?.code).toBe(1);
    expect(saidBeforeExiting()).toEqual([...BANNER, ...REFUSAL]);
    expect(clients).toEqual([]);
  });

  it("with ENGRAM_BASE_URL set too, runs against them, the file left alone", async () => {
    writeFileSync(CONFIG_FILE, BROKEN);
    vi.stubEnv("ENGRAM_API_KEY", ENV_KEY);
    vi.stubEnv("ENGRAM_BASE_URL", SERVER);
    await engram("search", "foo");
    expect(exits).toEqual([]);
    expect(clients).toEqual([{ baseUrl: SERVER, apiKey: ENV_KEY }]);
    expect(out).toEqual(["No results found."]);
    // Capture still waits on the file.
    expect(errs).toEqual(BANNER);
    expect(readFileSync(CONFIG_FILE, "utf-8")).toBe(BROKEN);
  });

  it("once the file reads fine, the client goes to the server and key in it", async () => {
    writeFileSync(CONFIG_FILE, JSON.stringify({ apiKey: FILE_KEY, baseUrl: `${SERVER}/` }));
    await engram("search", "foo");
    expect(exits).toEqual([]);
    expect(clients).toEqual([{ baseUrl: SERVER, apiKey: FILE_KEY }]);
    expect(out).toEqual(["No results found."]);
    expect(errs).toEqual([]);
  });
});
