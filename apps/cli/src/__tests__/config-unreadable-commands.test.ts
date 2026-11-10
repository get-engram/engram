import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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

// engram#673: commands, and a ~/.engram/config.json they can't read.
//
// Read leniently, a file that couldn't be read or parsed read as no
// settings. A command that saved settings then replaced it, and the API key
// and the folders excluded from capture in it were gone for good; `engram
// signup` made a second account, as there was no key in it; and the key
// and password commands went to the default server whatever the file
// named. Each now stops, says why, and leaves the file as it was, with
// nothing sent anywhere. An empty file has nothing in it to lose: commands
// that save settings may write it, and say what that means.

const { home } = vi.hoisted(() => ({ home: { dir: "" } }));

// config.ts reads ~/.engram/config.json: point it at a temp home.
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));

home.dir = mkdtempSync(join(tmpdir(), "engram-673-commands-"));
const ENGRAM = join(home.dir, ".engram");
const CONFIG = join(ENGRAM, "config.json");
const ELSEWHERE = join(home.dir, "elsewhere", "config.json");
const WORK = join(home.dir, "work", "client");
const TAIL = "Q9Z7LEAK";
/** The key in the file, and the file cut short just after it: JSON.parse's own message quotes the end of the key. */
const SAVED_KEY = `engram_sk_live_test_673_${TAIL}`;
const BROKEN = `{"apiKey":"${SAVED_KEY}","n":x}`;
const LIST = JSON.stringify([{ apiKey: SAVED_KEY, excludePaths: [WORK] }]);
/** The key the fake server makes, one typed into `engram auth login`, and one in ENGRAM_API_KEY. */
const NEW_KEY = "engram_sk_live_test_673_minted_0123456789";
const TYPED_KEY = "engram_sk_live_test_673_typed_9876543210";
const ENV_KEY = "engram_sk_live_test_673_env_1357913579";
const saved = { key: process.env.ENGRAM_API_KEY, base: process.env.ENGRAM_BASE_URL };

const autoEnable = vi.fn(async () => {});
/** Every SDK client built: the server it was pointed at and its key. */
let clients: Array<{ baseUrl: string | undefined; apiKey: string }>;
let requests: Array<{ url: string; auth: string | null }>;
/** Run as the fake server answers a sign-up or a sign-in, before it does. */
let whileAnswering: () => void;
let logs: string[];
let errors: string[];

const plain = (a: unknown[]) => a.join(" ").replace(/\x1b\[[0-9;]*m/g, "");
const output = () => [...logs, ...errors].join("\n");
const writeConfig = (text: string) => {
  mkdirSync(ENGRAM, { recursive: true });
  writeFileSync(CONFIG, text);
};
const readConfig = () => JSON.parse(readFileSync(CONFIG, "utf-8")) as Record<string, unknown>;

/** The exit code `run` stopped with, or null when it returned. */
async function exitCode(run: () => Promise<unknown>): Promise<number | null> {
  try {
    await run();
    return null;
  } catch (err: unknown) {
    const m = /^exit (\d+)$/.exec(err instanceof Error ? err.message : "");
    if (!m) throw err;
    return Number(m[1]);
  }
}

/** None of the keys, or the end of one, was said. */
function expectNoKeyInOutput(): void {
  const said = output();
  for (const secret of [TAIL.slice(-4), "test_673", NEW_KEY.slice(-10), TYPED_KEY.slice(-10), ENV_KEY.slice(-10)]) {
    expect(said).not.toContain(secret);
  }
}

beforeEach(() => {
  rmSync(ENGRAM, { recursive: true, force: true });
  rmSync(join(home.dir, "elsewhere"), { recursive: true, force: true });
  delete process.env.ENGRAM_API_KEY;
  delete process.env.ENGRAM_BASE_URL;
  clients = [];
  requests = [];
  whileAnswering = () => {};
  logs = [];
  errors = [];
  autoEnable.mockClear();
  vi.resetModules();
  vi.doMock("@getengram/sdk", () => ({
    Engram: class {
      constructor(config: { apiKey: string; baseUrl?: string }) {
        clients.push({ baseUrl: config.baseUrl, apiKey: config.apiKey });
      }
      async listConversations() {
        return [];
      }
    },
  }));
  vi.doMock("../daemon/commands.js", () => ({ autoEnableCapture: autoEnable }));
  // A command that asked before reading config.json would be asking for a
  // password it can't use.
  vi.doMock("node:readline", () => ({
    createInterface: () => {
      throw new Error("prompted");
    },
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (url.endsWith("/signup/anonymous") || url.endsWith("/signup/login")) {
        whileAnswering();
        return new Response(JSON.stringify({ organization_id: "org_test_673", api_key: NEW_KEY }), { status: 200 });
      }
      if (url.endsWith("/api/usage")) {
        const usage = { tier: "free", period: null, messages: { used: 0, limit: 1 }, searches: { used: 0 } };
        return new Response(JSON.stringify(usage), { status: 200 });
      }
      throw new Error(`unexpected request to ${url}`);
    }),
  );
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(plain(a)));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(plain(a)));
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock("@getengram/sdk");
  vi.doUnmock("../daemon/commands.js");
  vi.doUnmock("node:readline");
  if (saved.key === undefined) delete process.env.ENGRAM_API_KEY;
  else process.env.ENGRAM_API_KEY = saved.key;
  if (saved.base === undefined) delete process.env.ENGRAM_BASE_URL;
  else process.env.ENGRAM_BASE_URL = saved.base;
});

afterAll(() => rmSync(home.dir, { recursive: true, force: true }));

const exclude = () => import("../commands/exclude.js");
const auth = () => import("../commands/auth.js");
const account = () => import("../commands/login.js");

/**
 * How a command stops: one that saves settings won't save over the file;
 * one that uses the key or the server in it can't tell which; `exclude
 * list` can't say what is excluded.
 */
type Kind = "save" | "use" | "list";

function refusal(kind: Kind, problem: string, hints: string[] = []): string[] {
  switch (kind) {
    case "save":
      return [
        `Error: ~/.engram/config.json ${problem}.`,
        "  Saving now would replace everything in it, your API key and the folders you",
        "  excluded from capture among them, so nothing was changed.",
        "  Fix the file, then run this again.",
        ...hints,
      ];
    case "use":
      return [
        `Error: ~/.engram/config.json ${problem}, so Engram can't tell which account or server to use.`,
        "  Fix the file, then run this again.",
      ];
    case "list":
      return [
        `Error: ~/.engram/config.json ${problem}, so the folders excluded from capture can't be listed.`,
        "  Fix the file, then run this again.",
      ];
  }
}

const COMMANDS: Array<{ name: string; kind: Kind; run: () => Promise<unknown>; hints?: string[] }> = [
  { name: "exclude add", kind: "save", run: async () => (await exclude()).excludeAdd([WORK]) },
  { name: "exclude remove", kind: "save", run: async () => (await exclude()).excludeRemove([WORK]) },
  { name: "exclude list", kind: "list", run: async () => (await exclude()).excludeList() },
  { name: "auth login", kind: "save", run: async () => (await auth()).authLogin([TYPED_KEY]) },
  {
    name: "auth logout",
    kind: "save",
    run: async () => (await auth()).authLogout(),
    hints: [
      "  To sign out anyway: run 'engram stop', then remove the file. The folders you",
      "  excluded from capture go with it.",
    ],
  },
  { name: "auth status", kind: "use", run: async () => (await auth()).authStatus() },
  { name: "signup", kind: "save", run: async () => (await account()).signup() },
  {
    name: "login --email --password",
    kind: "save",
    run: async () => (await account()).login([], { email: "a@example.com", password: "pw-for-tests-only" }),
  },
  { name: "login, asking", kind: "save", run: async () => (await account()).login([], {}) },
  { name: "whoami", kind: "use", run: async () => (await account()).whoami() },
  { name: "link", kind: "use", run: async () => (await account()).link([], { email: "a@example.com" }) },
  { name: "usage", kind: "use", run: async () => (await import("../commands/usage.js")).usage([], {}) },
  { name: "upgrade", kind: "use", run: async () => (await import("../commands/upgrade.js")).upgrade([], {}) },
];

/** Ways a config.json can't be read: how to make one, and that it is as it was. */
const PROBLEMS: Array<{ problem: string; make: () => void; unchanged: () => void }> = [
  {
    problem: "isn't valid JSON",
    make: () => writeConfig(BROKEN),
    unchanged: () => expect(readFileSync(CONFIG, "utf-8")).toBe(BROKEN),
  },
  {
    problem: "isn't a JSON object",
    make: () => writeConfig(LIST),
    unchanged: () => expect(readFileSync(CONFIG, "utf-8")).toBe(LIST),
  },
  {
    problem: "is a folder, not a file",
    make: () => mkdirSync(CONFIG, { recursive: true }),
    unchanged: () => expect(readdirSync(CONFIG)).toEqual([]),
  },
  // Making a symlink on Windows takes a privilege CI may not have.
  ...(process.platform === "win32"
    ? []
    : [
        {
          problem: "is a link to a file that isn't there",
          make: () => {
            mkdirSync(ENGRAM, { recursive: true });
            symlinkSync(ELSEWHERE, CONFIG);
          },
          unchanged: () => {
            expect(lstatSync(CONFIG).isSymbolicLink()).toBe(true);
            expect(readlinkSync(CONFIG)).toBe(ELSEWHERE);
            expect(existsSync(ELSEWHERE)).toBe(false);
          },
        },
      ]),
];

describe.each(PROBLEMS)("a config.json that $problem (engram#673)", ({ problem, make, unchanged }) => {
  it.each(COMMANDS)("engram $name stops, says why, and changes and sends nothing", async ({ kind, run, hints }) => {
    make();
    expect(await exitCode(run)).toBe(1);
    expect(errors).toEqual(refusal(kind, problem, hints));
    expect(logs).toEqual([]);
    // The key and the folders excluded in it are as they were.
    unchanged();
    expect(readdirSync(ENGRAM)).toEqual(["config.json"]);
    // Nothing went to any server: not a key, nor a password.
    expect(requests).toEqual([]);
    expect(clients).toEqual([]);
    expect(autoEnable).not.toHaveBeenCalled();
    expectNoKeyInOutput();
  });
});

describe("ENGRAM_API_KEY and ENGRAM_BASE_URL, with a config.json that can't be read (engram#673)", () => {
  it.each(COMMANDS.filter((c) => c.kind === "use"))(
    "engram $name with ENGRAM_API_KEY alone still stops: the server to send it to is in the file",
    async ({ run }) => {
      writeConfig(BROKEN);
      process.env.ENGRAM_API_KEY = ENV_KEY;
      expect(await exitCode(run)).toBe(1);
      expect(errors).toEqual(refusal("use", "isn't valid JSON"));
      expect(requests).toEqual([]);
      expect(clients).toEqual([]);
      expectNoKeyInOutput();
    },
  );

  it("with both set, commands that only use them run, and the file is left alone", async () => {
    writeConfig(BROKEN);
    process.env.ENGRAM_API_KEY = ENV_KEY;
    process.env.ENGRAM_BASE_URL = "http://127.0.0.1:8788";
    const { authStatus } = await auth();
    expect(await exitCode(authStatus)).toBeNull();
    expect(logs).toEqual(["Authenticated via ENGRAM_API_KEY env var", `  Key prefix: ${ENV_KEY.slice(0, 20)}...`]);
    const { fetchUsage } = await import("../commands/usage.js");
    expect((await fetchUsage()).kind).toBe("ok");
    expect(requests).toEqual([{ url: "http://127.0.0.1:8788/api/usage", auth: `Bearer ${ENV_KEY}` }]);
    expect(errors).toEqual([]);
    expect(readFileSync(CONFIG, "utf-8")).toBe(BROKEN);
  });

  it.each(COMMANDS.filter((c) => c.kind === "save"))(
    "with both set, engram $name still won't save over the file",
    async ({ run, hints }) => {
      writeConfig(BROKEN);
      process.env.ENGRAM_API_KEY = ENV_KEY;
      process.env.ENGRAM_BASE_URL = "http://127.0.0.1:8788";
      expect(await exitCode(run)).toBe(1);
      expect(errors).toEqual(refusal("save", "isn't valid JSON", hints));
      expect(readFileSync(CONFIG, "utf-8")).toBe(BROKEN);
      expect(requests).toEqual([]);
      expect(clients).toEqual([]);
    },
  );

  it("fetchUsage says it's config.json, not that no one is signed in", async () => {
    writeConfig(BROKEN);
    const { fetchUsage } = await import("../commands/usage.js");
    const result = await fetchUsage();
    expect(result.kind).toBe("config");
    expect(result.kind === "config" ? result.problem.message : null).toBe("~/.engram/config.json isn't valid JSON");
    expect(requests).toEqual([]);
  });
});

describe("an excludePaths that isn't a list of paths (engram#673)", () => {
  const TEXT = JSON.stringify({ apiKey: SAVED_KEY, excludePaths: "/work" });

  it.each([
    { name: "add", what: "changed", run: async () => (await exclude()).excludeAdd([WORK]) },
    { name: "remove", what: "changed", run: async () => (await exclude()).excludeRemove([WORK]) },
    { name: "list", what: "listed", run: async () => (await exclude()).excludeList() },
  ])("engram exclude $name stops, and the file is as it was", async ({ what, run }) => {
    writeConfig(TEXT);
    expect(await exitCode(run)).toBe(1);
    expect(errors).toEqual([
      `Error: ~/.engram/config.json has an excludePaths that isn't a list of paths, so the folders excluded from capture can't be ${what}.`,
      "  Fix the file, then run this again.",
    ]);
    expect(readFileSync(CONFIG, "utf-8")).toBe(TEXT);
    expectNoKeyInOutput();
  });
});

describe("an empty config.json (engram#673)", () => {
  const NOTE = [
    "Note: ~/.engram/config.json was empty, so any folders you had excluded from",
    "  capture are lost. Add them back with: engram exclude add <path>",
  ];

  it("engram exclude add saves into it, and says folders excluded before are gone", async () => {
    writeConfig("");
    const { excludeAdd } = await exclude();
    expect(await exitCode(() => excludeAdd([WORK]))).toBeNull();
    expect(errors).toEqual(NOTE);
    expect(readConfig()).toEqual({ excludePaths: [WORK] });
  });

  it("engram signup makes an account and saves its key, saying so once", async () => {
    writeConfig("\n");
    const { signup } = await account();
    expect(await exitCode(signup)).toBeNull();
    expect(errors).toEqual(NOTE);
    expect(requests.map((r) => r.url)).toEqual(["https://mcp.getengram.app/signup/anonymous"]);
    expect(readConfig()).toEqual({ apiKey: NEW_KEY });
    expect(autoEnable).toHaveBeenCalledOnce();
  });

  it("engram exclude list says capture waits on it, and changes nothing", async () => {
    writeConfig("");
    const { excludeList } = await exclude();
    expect(await exitCode(excludeList)).toBeNull();
    expect(errors).toEqual([
      "~/.engram/config.json is empty, so capture waits. Add back any folders you had",
      "  excluded ('engram exclude add <path>'), then sign in again ('engram login').",
      "",
    ]);
    expect(logs[0]).toBe("No excluded paths.");
    expect(readFileSync(CONFIG, "utf-8")).toBe("");
  });

  it("engram auth status reads it as no key", async () => {
    writeConfig("");
    const { authStatus } = await auth();
    expect(await exitCode(authStatus)).toBeNull();
    expect(logs[0]).toBe("Not authenticated");
  });
});

describe("no config.json (engram#673)", () => {
  it("engram exclude add makes one", async () => {
    const { excludeAdd } = await exclude();
    expect(await exitCode(() => excludeAdd([WORK]))).toBeNull();
    expect(errors).toEqual([]);
    expect(readConfig()).toEqual({ excludePaths: [WORK] });
  });
});

describe("config.json changed while the server answers (engram#673)", () => {
  it.each([
    { command: "signup", run: async () => (await account()).signup() },
    {
      command: "login",
      run: async () => (await account()).login([], { email: "a@example.com", password: "pw-for-tests-only" }),
    },
  ])("broken: engram $command doesn't save the new key over it, or say the key", async ({ command, run }) => {
    whileAnswering = () => writeConfig(BROKEN);
    expect(await exitCode(run)).toBe(1);
    expect(errors).toEqual([
      "Error: ~/.engram/config.json isn't valid JSON, so the new API key wasn't saved.",
      `  Fix the file, then run 'engram ${command}' again.`,
    ]);
    expect(readFileSync(CONFIG, "utf-8")).toBe(BROKEN);
    expect(autoEnable).not.toHaveBeenCalled();
    expectNoKeyInOutput();
  });

  it("still readable: engram signup saves the new key with what the file holds by then", async () => {
    whileAnswering = () => writeConfig(JSON.stringify({ excludePaths: [WORK] }));
    const { signup } = await account();
    expect(await exitCode(signup)).toBeNull();
    expect(readConfig()).toEqual({ excludePaths: [WORK], apiKey: NEW_KEY });
  });
});

describe("the usage check before an import (engram#673)", () => {
  /** An export with one conversation, and a client that records where it stored. */
  function anImport() {
    const file = join(home.dir, "conversations.json");
    const conversation = { uuid: "u-673", name: "Chat", created_at: "2026-11-09", chat_messages: [{ sender: "human", text: "hi" }] };
    writeFileSync(file, JSON.stringify([conversation]));
    const stored: string[] = [];
    const client = {
      createConversation: async () => ({ conversationId: "c-673", existing: false }),
      store: async ({ conversationId }: { conversationId: string }) => void stored.push(conversationId),
    };
    return { file, stored, client };
  }

  it("asks the server config.json names, with its key", async () => {
    writeConfig(JSON.stringify({ apiKey: SAVED_KEY, baseUrl: "http://127.0.0.1:8788/" }));
    const { file, stored, client } = anImport();
    const { importHistory } = await import("../commands/import.js");
    expect(await exitCode(() => importHistory(client as never, [file], {}))).toBeNull();
    expect(requests).toEqual([{ url: "http://127.0.0.1:8788/api/usage", auth: `Bearer ${SAVED_KEY}` }]);
    expect(stored).toEqual(["c-673"]);
  });

  it("sends nothing once config.json can't be read, not ENGRAM_API_KEY to the default server either", async () => {
    // The import's client was made before the file broke; the check reads it again.
    writeConfig(BROKEN);
    process.env.ENGRAM_API_KEY = ENV_KEY;
    const { file, stored, client } = anImport();
    const { importHistory } = await import("../commands/import.js");
    expect(await exitCode(() => importHistory(client as never, [file], {}))).toBeNull();
    expect(requests).toEqual([]);
    // A check that can't be made never stops the import: the server holds the cap.
    expect(stored).toEqual(["c-673"]);
    expect(readFileSync(CONFIG, "utf-8")).toBe(BROKEN);
    expectNoKeyInOutput();
  });
});
