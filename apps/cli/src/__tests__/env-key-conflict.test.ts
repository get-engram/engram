import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// engram#757: a stale ENGRAM_API_KEY won over the key `engram auth login`
// had just saved to config.json, and nothing said so. Every send was
// refused with the old key while the new one sat unused. Saving a key now
// says when the variable holds another one, and `auth status` and `whoami`
// name the saved key it leaves unused.

const { home } = vi.hoisted(() => ({ home: { dir: "" } }));

// config.ts reads ~/.engram/config.json: point it at a temp home.
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));

home.dir = mkdtempSync(join(tmpdir(), "engram-757-"));
const CONFIG = join(home.dir, ".engram", "config.json");
const NEW_KEY = "engram_sk_live_NEWKEY_757_0123456789";
const ENV_KEY = "engram_sk_live_ENVKEY_757_9876543210";
const SAVED_KEY = "engram_sk_live_SAVEDK_757_5555555555";
const WINS = "ENGRAM_API_KEY is set to another key";
const UNUSED = "holds another key";
const saved = { key: process.env.ENGRAM_API_KEY, url: process.env.ENGRAM_BASE_URL };
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

let out: string[];

const writeConfig = (config: object) => {
  mkdirSync(join(home.dir, ".engram"), { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(config));
};
const readConfig = () => JSON.parse(readFileSync(CONFIG, "utf-8")) as Record<string, unknown>;
const printed = () => out.join("\n");

beforeEach(() => {
  rmSync(join(home.dir, ".engram"), { recursive: true, force: true });
  delete process.env.ENGRAM_API_KEY;
  delete process.env.ENGRAM_BASE_URL;
  out = [];
  vi.resetModules();
  vi.doMock("@getengram/sdk", () => ({
    Engram: class {
      async listConversations() {
        return [];
      }
    },
  }));
  vi.doMock("../daemon/commands.js", () => ({ autoEnableCapture: vi.fn(async () => {}) }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/signup/login") || url.endsWith("/signup/anonymous")) {
        return new Response(JSON.stringify({ organization_id: "org_test_757", api_key: NEW_KEY }), { status: 200 });
      }
      if (url.endsWith("/api/account")) {
        return new Response(
          JSON.stringify({ org_id: "org_test_757", email: null, name: null, tier: "free" }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected request to ${url}`);
    }),
  );
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock("@getengram/sdk");
  vi.doUnmock("../daemon/commands.js");
  Object.defineProperty(process, "platform", platform);
  if (saved.key === undefined) delete process.env.ENGRAM_API_KEY;
  else process.env.ENGRAM_API_KEY = saved.key;
  if (saved.url === undefined) delete process.env.ENGRAM_BASE_URL;
  else process.env.ENGRAM_BASE_URL = saved.url;
});

afterAll(() => rmSync(home.dir, { recursive: true, force: true }));

const authLogin = async (key = NEW_KEY) => (await import("../commands/auth.js")).authLogin([key]);
const authStatus = async () => (await import("../commands/auth.js")).authStatus();

describe("engram auth login says when ENGRAM_API_KEY holds another key (engram#757)", () => {
  it("saves the key, and says the variable wins, where, and how to use the saved key", async () => {
    process.env.ENGRAM_API_KEY = ENV_KEY;
    await authLogin();
    expect(readConfig().apiKey).toBe(NEW_KEY);
    const text = printed();
    expect(text).toContain("✓ Authenticated successfully");
    expect(text).toContain(`${WINS} (${ENV_KEY.slice(0, 20)}...)`);
    expect(text).toContain("a daemon started from it, keep using ENGRAM_API_KEY");
    expect(text).toMatch(/unset it, then run '[^']*stop' and '[^']*start'/);
  });

  it("says nothing when the variable holds the key just saved", async () => {
    process.env.ENGRAM_API_KEY = NEW_KEY;
    await authLogin();
    expect(readConfig().apiKey).toBe(NEW_KEY);
    expect(printed()).not.toContain(WINS);
  });

  it("says nothing when the variable is unset or empty", async () => {
    await authLogin();
    expect(printed()).not.toContain(WINS);
    process.env.ENGRAM_API_KEY = "";
    await authLogin();
    expect(printed()).not.toContain(WINS);
  });

  it("on Windows, also says a user environment variable reaches the daemon started at sign-in", async () => {
    process.env.ENGRAM_API_KEY = ENV_KEY;
    const { envKeyWinsLines } = await import("../env-key.js");
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    expect(envKeyWinsLines(NEW_KEY).join("\n")).not.toContain("Windows");
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    expect(envKeyWinsLines(NEW_KEY).join("\n")).toContain(
      "If it is one of your Windows user environment variables, remove it there too",
    );
  });
});

describe("engram login and signup say the same when they save a key (engram#757)", () => {
  it("login, with a new key for this machine", async () => {
    process.env.ENGRAM_API_KEY = ENV_KEY;
    const { login } = await import("../commands/login.js");
    await login([], { email: "a@example.com", password: "pw-for-tests-only" });
    expect(readConfig().apiKey).toBe(NEW_KEY);
    expect(printed()).toContain(`${WINS} (${ENV_KEY.slice(0, 20)}...)`);
  });

  it("login, not when the variable holds the new key", async () => {
    process.env.ENGRAM_API_KEY = NEW_KEY;
    const { login } = await import("../commands/login.js");
    await login([], { email: "a@example.com", password: "pw-for-tests-only" });
    expect(printed()).not.toContain(WINS);
  });

  it("signup", async () => {
    process.env.ENGRAM_API_KEY = ENV_KEY;
    const { signup } = await import("../commands/login.js");
    await signup();
    expect(readConfig().apiKey).toBe(NEW_KEY);
    expect(printed()).toContain(`${WINS} (${ENV_KEY.slice(0, 20)}...)`);
  });
});

describe("engram auth status and whoami name the saved key ENGRAM_API_KEY leaves unused (engram#757)", () => {
  it("auth status, when config.json holds another key", async () => {
    writeConfig({ apiKey: SAVED_KEY });
    process.env.ENGRAM_API_KEY = ENV_KEY;
    await authStatus();
    const text = printed();
    expect(text).toContain("Authenticated via ENGRAM_API_KEY env var");
    expect(text).toContain(`~/.engram/config.json ${UNUSED} (${SAVED_KEY.slice(0, 20)}...), unused while ENGRAM_API_KEY is set.`);
  });

  it("auth status, not when both hold the same key, or the variable is unset, or nothing is saved", async () => {
    writeConfig({ apiKey: SAVED_KEY });
    process.env.ENGRAM_API_KEY = SAVED_KEY;
    await authStatus();
    delete process.env.ENGRAM_API_KEY;
    await authStatus();
    writeConfig({});
    process.env.ENGRAM_API_KEY = ENV_KEY;
    await authStatus();
    expect(printed()).not.toContain(UNUSED);
  });

  it("whoami, when config.json holds another key", async () => {
    writeConfig({ apiKey: SAVED_KEY });
    process.env.ENGRAM_API_KEY = ENV_KEY;
    const { whoami } = await import("../commands/login.js");
    await whoami();
    expect(printed()).toContain(`${UNUSED} (${SAVED_KEY.slice(0, 20)}...)`);
  });
});
