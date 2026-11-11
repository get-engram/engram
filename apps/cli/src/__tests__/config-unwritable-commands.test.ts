import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// engram#717: commands, and a ~/.engram/config.json they can read but not
// write.
//
// A save that failed ended the command with Node's own error, which named
// the path and nothing else. By then `engram signup` had made an account,
// and `engram login` an API key, that the save lost: an account no one
// could use, or a key left live in the account, and each try made one
// more. Both now check that config.json can be written before they ask for
// anything, and every command that saves it says why it couldn't, what
// that means for the command, and what fixes it, and exits 1.

const { home, fail } = vi.hoisted(() => ({
  home: { dir: "" },
  /** What private-files.js throws in place of checking, or of writing. */
  fail: { check: null as Error | null, write: null as Error | null },
}));

// config.ts keeps config.json in ~/.engram: a temp home.
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));

// A full disk, or a read-only one, can't be made in a test: these throw
// what the real calls would. Otherwise they are the real calls.
vi.mock("../private-files.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../private-files.js")>();
  return {
    ...real,
    checkWritableSync: (file: string) => {
      if (fail.check) throw fail.check;
      real.checkWritableSync(file);
    },
    writePrivateFileSync: (...args: Parameters<typeof real.writePrivateFileSync>) => {
      if (fail.write) throw fail.write;
      real.writePrivateFileSync(...args);
    },
  };
});

home.dir = mkdtempSync(join(tmpdir(), "engram-717-"));
const ENGRAM = join(home.dir, ".engram");
const CONFIG = join(ENGRAM, "config.json");
const WORK = join(home.dir, "work", "client");
const OTHER = join(home.dir, "work", "other");
const SAVED_KEY = "engram_sk_live_test_717_saved_2468024680";
/** The key the fake server makes, and one typed into `engram auth login`. */
const NEW_KEY = "engram_sk_live_test_717_minted_0123456789";
const TYPED_KEY = "engram_sk_live_test_717_typed_9876543210";
/** Settings with no key, as `engram signup` needs, and with one. */
const NO_KEY = JSON.stringify({ excludePaths: [WORK] }, null, 2) + "\n";
const WITH_KEY = JSON.stringify({ apiKey: SAVED_KEY, excludePaths: [WORK] }, null, 2) + "\n";

const posix = process.platform !== "win32";
/** Root can write whatever the modes say. */
const root = process.geteuid?.() === 0;

const autoEnable = vi.fn(async () => {});
/** Every SDK client built, with the key it was given. */
let clients: string[];
let requests: string[];
/** Run as the fake server answers, before it does. */
let whileAnswering: () => void;
let logs: string[];
let errors: string[];

const plain = (a: unknown[]) => a.join(" ").replace(/\x1b\[[0-9;]*m/g, "");
const output = () => [...logs, ...errors].join("\n");
const errno = (code: string) => Object.assign(new Error(`${code}: injected, '${CONFIG}'`), { code });
/** As an install since engram#627 has them: the folder 0700, the file 0600. */
const writeConfig = (text: string) => {
  mkdirSync(ENGRAM, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG, text, { mode: 0o600 });
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

/** What a command could have changed: the home folder, ~/.engram, the files in it and their modes. */
function state() {
  const mode = (path: string) => {
    try {
      return statSync(path).mode & 0o777;
    } catch {
      return null;
    }
  };
  let files: Record<string, string> | null = null;
  try {
    files = Object.fromEntries(readdirSync(ENGRAM).map((name) => [name, readFileSync(join(ENGRAM, name), "utf-8")]));
  } catch {
    // no ~/.engram
  }
  return { home: mode(home.dir), list: readdirSync(home.dir).sort(), engram: mode(ENGRAM), config: mode(CONFIG), files };
}

/** No key, nor the end of one, was said, nor Node's message, which names the path in full. */
function expectNothingPrivateSaid(): void {
  const said = output();
  for (const secret of ["test_717", SAVED_KEY.slice(-10), NEW_KEY.slice(-10), TYPED_KEY.slice(-10)]) {
    expect(said).not.toContain(secret);
  }
  expect(said).not.toContain(ENGRAM);
  expect(said).not.toContain("injected");
}

/** Modes a test took away, given back so the next one, and the cleanup, can write. */
function restoreModes(): void {
  if (!posix) return;
  chmodSync(home.dir, 0o700);
  for (const [path, mode] of [[ENGRAM, 0o700], [CONFIG, 0o600]] as const) {
    try {
      chmodSync(path, mode);
    } catch {
      // not there
    }
  }
}

beforeEach(() => {
  restoreModes();
  rmSync(ENGRAM, { recursive: true, force: true });
  delete process.env.ENGRAM_API_KEY;
  delete process.env.ENGRAM_BASE_URL;
  fail.check = null;
  fail.write = null;
  clients = [];
  requests = [];
  whileAnswering = () => {};
  logs = [];
  errors = [];
  autoEnable.mockClear();
  vi.resetModules();
  vi.doMock("@getengram/sdk", () => ({
    Engram: class {
      constructor(config: { apiKey: string }) {
        clients.push(config.apiKey);
      }
      async listConversations() {
        whileAnswering();
        return [];
      }
    },
  }));
  vi.doMock("../daemon/commands.js", () => ({ autoEnableCapture: autoEnable }));
  // A command that asked for a password before finding it can't save
  // what signing in makes would have asked for nothing.
  vi.doMock("node:readline", () => ({
    createInterface: () => {
      throw new Error("prompted");
    },
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/signup/anonymous") || url.endsWith("/signup/login")) {
        whileAnswering();
        return new Response(JSON.stringify({ organization_id: "org_test_717", api_key: NEW_KEY }), { status: 200 });
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
  restoreModes();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock("@getengram/sdk");
  vi.doUnmock("../daemon/commands.js");
  vi.doUnmock("node:readline");
});

afterAll(() => {
  restoreModes();
  rmSync(home.dir, { recursive: true, force: true });
});

const exclude = () => import("../commands/exclude.js");
const auth = () => import("../commands/auth.js");
const account = () => import("../commands/login.js");

const LOGIN_FLAGS = { email: "a@example.com", password: "pw-for-tests-only" };

/**
 * Each command that saves config.json: the settings it needs there (the
 * ones that only add to the file run with none as well), what it says a
 * failed save means, and what it says to run again. A command given a key
 * says "this", so the key isn't shown again.
 */
const COMMANDS: Array<{
  name: string;
  settings: string;
  needsSettings: boolean;
  run: () => Promise<unknown>;
  meaning: string[];
  again: string;
}> = [
  {
    name: "signup",
    settings: NO_KEY,
    needsSettings: false,
    run: async () => (await account()).signup(),
    meaning: ["A new account's API key is saved there, so no account was made."],
    again: "'engram signup'",
  },
  {
    name: "login --email --password",
    settings: WITH_KEY,
    needsSettings: false,
    run: async () => (await account()).login([], LOGIN_FLAGS),
    meaning: ["Signing in saves a new API key there, so it wasn't tried."],
    again: "'engram login'",
  },
  {
    name: "login, asking",
    settings: WITH_KEY,
    needsSettings: false,
    run: async () => (await account()).login([], {}),
    meaning: ["Signing in saves a new API key there, so it wasn't tried."],
    again: "'engram login'",
  },
  {
    name: "auth login",
    settings: WITH_KEY,
    needsSettings: false,
    run: async () => (await auth()).authLogin([TYPED_KEY]),
    meaning: ["So the key wasn't checked or saved."],
    again: "this",
  },
  {
    name: "auth logout",
    settings: WITH_KEY,
    needsSettings: true,
    run: async () => (await auth()).authLogout(),
    meaning: ["You're still signed in, and auto-capture keeps using the key saved there."],
    again: "'engram auth logout'",
  },
  {
    name: "exclude add",
    settings: WITH_KEY,
    needsSettings: false,
    run: async () => (await exclude()).excludeAdd([OTHER]),
    meaning: [`Not excluded: sessions in ${OTHER} are still captured.`],
    again: "this",
  },
  {
    name: "exclude remove",
    settings: WITH_KEY,
    needsSettings: true,
    run: async () => (await exclude()).excludeRemove([WORK]),
    meaning: [`Still excluded from capture: ${WORK}`],
    again: "this",
  },
];

/** What a command says when config.json can't be saved. */
function refusal(problem: string, meaning: string[], again: string, fix: string | null): string[] {
  return [
    `Error: ~/.engram/config.json ${problem}.`,
    ...meaning.map((line) => `  ${line}`),
    ...(fix ? [`  To fix it, run: ${fix}`, `  Then run ${again} again.`] : [`  Once it's fixed, run ${again} again.`]),
  ];
}

/** It stopped before doing anything: nothing sent, asked, saved or started. */
function expectNothingDone(before: ReturnType<typeof state>): void {
  expect(logs).toEqual([]);
  expect(requests).toEqual([]);
  expect(clients).toEqual([]);
  expect(autoEnable).not.toHaveBeenCalled();
  expect(state()).toEqual(before);
  expectNothingPrivateSaid();
}

describe.skipIf(!posix || root)("a config.json the user can't write (engram#717)", () => {
  const UNWRITABLE: Array<{ what: string; settings: boolean; make: (text: string) => void; fix: string | null }> = [
    {
      what: "config.json is read-only",
      settings: true,
      make: (text) => {
        writeConfig(text);
        chmodSync(CONFIG, 0o400);
      },
      fix: "chmod u+w ~/.engram/config.json",
    },
    {
      what: "~/.engram is read-only",
      settings: true,
      make: (text) => {
        writeConfig(text);
        chmodSync(ENGRAM, 0o500);
      },
      fix: "chmod u+w ~/.engram",
    },
    {
      what: "both are read-only",
      settings: true,
      make: (text) => {
        writeConfig(text);
        chmodSync(CONFIG, 0o400);
        chmodSync(ENGRAM, 0o500);
      },
      fix: "chmod u+w ~/.engram ~/.engram/config.json",
    },
    {
      what: "~/.engram is read-only, with no config.json in it",
      settings: false,
      make: () => {
        mkdirSync(ENGRAM, { mode: 0o700 });
        chmodSync(ENGRAM, 0o500);
      },
      fix: "chmod u+w ~/.engram",
    },
    {
      // Not a mode of Engram's own files: no command that would fix it is offered.
      what: "the home folder is read-only, with no ~/.engram in it",
      settings: false,
      make: () => chmodSync(home.dir, 0o500),
      fix: null,
    },
  ];

  describe.each(UNWRITABLE)("$what", ({ settings, make, fix }) => {
    it.each(COMMANDS.filter((c) => settings || !c.needsSettings))(
      "engram $name stops, says why, what that means and what fixes it, and changes nothing",
      async ({ settings: text, run, meaning, again }) => {
        make(text);
        const before = state();
        expect(await exitCode(run)).toBe(1);
        expect(errors).toEqual(refusal("can't be written: permission denied", meaning, again, fix));
        expectNothingDone(before);
      },
    );
  });

  it("engram signup, in full: no account is made", async () => {
    writeConfig(NO_KEY);
    chmodSync(CONFIG, 0o400);
    const { signup } = await account();
    expect(await exitCode(signup)).toBe(1);
    expect(errors).toEqual([
      "Error: ~/.engram/config.json can't be written: permission denied.",
      "  A new account's API key is saved there, so no account was made.",
      "  To fix it, run: chmod u+w ~/.engram/config.json",
      "  Then run 'engram signup' again.",
    ]);
    expect(requests).toEqual([]);
  });

  it("once it's fixed as it says, engram login signs in and saves the key with what was there", async () => {
    writeConfig(WITH_KEY);
    chmodSync(ENGRAM, 0o500);
    const { login } = await account();
    expect(await exitCode(() => login([], LOGIN_FLAGS))).toBe(1);
    expect(errors).toContain("  To fix it, run: chmod u+w ~/.engram");
    chmodSync(ENGRAM, statSync(ENGRAM).mode | 0o200); // chmod u+w
    errors = [];
    expect(await exitCode(() => login([], LOGIN_FLAGS))).toBeNull();
    expect(errors).toEqual([]);
    expect(requests).toEqual(["https://mcp.getengram.app/signup/login"]);
    expect(readConfig()).toEqual({ apiKey: NEW_KEY, excludePaths: [WORK] });
    expect(autoEnable).toHaveBeenCalledOnce();
  });

  it("engram auth logout with no key saved has nothing to remove, so it writes nothing and doesn't stop", async () => {
    writeConfig(NO_KEY);
    chmodSync(CONFIG, 0o400);
    const before = state();
    const { authLogout } = await auth();
    expect(await exitCode(authLogout)).toBeNull();
    expect(errors).toEqual([]);
    expect(logs[0]).toBe("✓ Logged out");
    expect(state()).toEqual(before);
  });
});

describe("a disk config.json can't be written to, whatever the modes say (engram#717)", () => {
  // EPERM: a file locked some other way, such as macOS's immutable flag,
  // or on Windows. chmod can't change either, so no command is offered.
  it.each([
    { code: "EROFS", problem: "can't be written: the disk it's on is read-only" },
    { code: "EPERM", problem: "can't be written: permission denied" },
  ])("$code: every command stops before doing anything, and offers no command to run", async ({ code, problem }) => {
    for (const { name, settings, run, meaning, again } of COMMANDS) {
      rmSync(ENGRAM, { recursive: true, force: true });
      writeConfig(settings);
      fail.check = errno(code);
      fail.write = errno(code);
      logs = [];
      errors = [];
      const before = state();
      expect(await exitCode(run), name).toBe(1);
      expect(errors, name).toEqual(refusal(problem, meaning, again, null));
      expectNothingDone(before);
    }
  });
});

describe("a disk that fills up after the check: the key is made, the save fails (engram#717)", () => {
  // Only a write finds a full disk, and a disk can fill up while the
  // server answers.
  beforeEach(() => {
    whileAnswering = () => {
      fail.write = errno("ENOSPC");
    };
  });

  it("engram signup says the account it made can't be used", async () => {
    writeConfig(NO_KEY);
    const before = state();
    const { signup } = await account();
    expect(await exitCode(signup)).toBe(1);
    expect(logs).toEqual(["Creating account..."]);
    expect(errors).toEqual([
      "Error: ~/.engram/config.json can't be written: the disk it's on is full.",
      "  An account was made, but its API key couldn't be saved, so it can't be used.",
      "  Once it's fixed, run 'engram signup' again.",
    ]);
    expect(requests).toEqual(["https://mcp.getengram.app/signup/anonymous"]);
    expect(autoEnable).not.toHaveBeenCalled();
    expect(state()).toEqual(before);
    expectNothingPrivateSaid();
  });

  it("engram login says a key was made, and where to delete it", async () => {
    writeConfig(WITH_KEY);
    const before = state();
    const { login } = await account();
    expect(await exitCode(() => login([], LOGIN_FLAGS))).toBe(1);
    expect(logs).toEqual(["Signing in..."]);
    expect(errors).toEqual([
      "Error: ~/.engram/config.json can't be written: the disk it's on is full.",
      "  A new API key was made for this machine, but it couldn't be saved.",
      '  It\'s listed at getengram.app/dashboard as "CLI login": delete it there.',
      "  Once it's fixed, run 'engram login' again.",
    ]);
    expect(requests).toEqual(["https://mcp.getengram.app/signup/login"]);
    expect(autoEnable).not.toHaveBeenCalled();
    // The key saved before is still the one used.
    expect(state()).toEqual(before);
    expectNothingPrivateSaid();
  });

  it("engram auth login says the key it checked wasn't saved", async () => {
    writeConfig(WITH_KEY);
    const before = state();
    const { authLogin } = await auth();
    expect(await exitCode(() => authLogin([TYPED_KEY]))).toBe(1);
    expect(clients).toEqual([TYPED_KEY]);
    expect(errors).toEqual([
      "Error: ~/.engram/config.json can't be written: the disk it's on is full.",
      "  So the key wasn't saved.",
      "  Once it's fixed, run this again.",
    ]);
    expect(logs).toEqual([]);
    expect(autoEnable).not.toHaveBeenCalled();
    expect(state()).toEqual(before);
    expectNothingPrivateSaid();
  });
});

describe("a config.json that can be written (engram#717)", () => {
  it("engram signup makes the account and saves its key with the settings already there", async () => {
    writeConfig(NO_KEY);
    const { signup } = await account();
    expect(await exitCode(signup)).toBeNull();
    expect(errors).toEqual([]);
    expect(requests).toEqual(["https://mcp.getengram.app/signup/anonymous"]);
    expect(readConfig()).toEqual({ excludePaths: [WORK], apiKey: NEW_KEY });
    expect(readdirSync(ENGRAM)).toEqual(["config.json"]);
    expect(autoEnable).toHaveBeenCalledOnce();
  });

  it("engram signup with no ~/.engram yet makes it", async () => {
    const { signup } = await account();
    expect(await exitCode(signup)).toBeNull();
    expect(readConfig()).toEqual({ apiKey: NEW_KEY });
  });

  it("engram auth logout with no key saved writes nothing, even where it couldn't", async () => {
    writeConfig(NO_KEY);
    fail.write = errno("EROFS");
    const { authLogout } = await auth();
    expect(await exitCode(authLogout)).toBeNull();
    expect(errors).toEqual([]);
    expect(logs[0]).toBe("✓ Logged out");
    expect(readFileSync(CONFIG, "utf-8")).toBe(NO_KEY);
  });

  it("engram auth logout removes the key, and keeps the rest", async () => {
    writeConfig(WITH_KEY);
    const { authLogout } = await auth();
    expect(await exitCode(authLogout)).toBeNull();
    expect(readConfig()).toEqual({ excludePaths: [WORK] });
  });
});
