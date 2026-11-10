import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// engram#625: `engram auth login` checked a key against the default server
// whatever was configured, and the account commands skipped baseUrl in
// config.json. A key could be checked or minted on one server, used on
// another, and sent to a server the user hadn't configured. Every command
// now resolves the server one way: ENGRAM_BASE_URL, then config.json, then
// the default.

const { home } = vi.hoisted(() => ({ home: { dir: "" } }));

// config.ts reads ~/.engram/config.json: point it at a temp home.
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));

home.dir = mkdtempSync(join(tmpdir(), "engram-625-"));
const CONFIG = join(home.dir, ".engram", "config.json");
const DEFAULT = "https://mcp.getengram.app";
const KEY = "engram_sk_live_test_625_0123456789";
const savedBaseUrl = process.env.ENGRAM_BASE_URL;

/** Every SDK client built: the server it was pointed at and its key. */
let clients: Array<{ baseUrl: string | undefined; apiKey: string }>;
/** Whether the fake server accepts the key auth login checks. */
let accepts: boolean;
let requests: Array<{ url: string; auth: string | null }>;
let out: string[];

const writeConfig = (config: object) => {
  mkdirSync(join(home.dir, ".engram"), { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(config));
};
const readConfig = () => JSON.parse(readFileSync(CONFIG, "utf-8")) as Record<string, unknown>;

beforeEach(() => {
  rmSync(join(home.dir, ".engram"), { recursive: true, force: true });
  delete process.env.ENGRAM_BASE_URL;
  clients = [];
  accepts = true;
  requests = [];
  out = [];
  vi.resetModules();
  vi.doMock("@getengram/sdk", () => ({
    Engram: class {
      constructor(config: { apiKey: string; baseUrl?: string }) {
        clients.push({ baseUrl: config.baseUrl, apiKey: config.apiKey });
      }
      async listConversations() {
        if (!accepts) throw new Error("401");
        return [];
      }
    },
  }));
  vi.doMock("../daemon/commands.js", () => ({ autoEnableCapture: vi.fn(async () => {}) }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (url.endsWith("/signup/login")) {
        return new Response(JSON.stringify({ organization_id: "org_test", api_key: KEY }), { status: 200 });
      }
      if (url.endsWith("/api/usage")) return new Response(JSON.stringify({}), { status: 200 });
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
  if (savedBaseUrl === undefined) delete process.env.ENGRAM_BASE_URL;
  else process.env.ENGRAM_BASE_URL = savedBaseUrl;
});

afterAll(() => rmSync(home.dir, { recursive: true, force: true }));

describe("resolveBaseUrl: one order for every command (engram#625)", () => {
  it("ENGRAM_BASE_URL, then baseUrl in config.json, then the default", async () => {
    const { resolveBaseUrl } = await import("../config.js");
    expect(resolveBaseUrl({})).toBe(DEFAULT);
    expect(resolveBaseUrl({ baseUrl: "http://staging.example.test/" })).toBe("http://staging.example.test");
    expect(resolveBaseUrl({ baseUrl: "  http://localhost:8787  " })).toBe("http://localhost:8787");
    process.env.ENGRAM_BASE_URL = "http://127.0.0.1:8788";
    expect(resolveBaseUrl({ baseUrl: "http://staging.example.test" })).toBe("http://127.0.0.1:8788");
  });

  it("a baseUrl that is empty or not a string is ignored", async () => {
    const { resolveBaseUrl } = await import("../config.js");
    for (const baseUrl of ["", "   ", 42, null, ["http://x.test"]]) {
      expect(resolveBaseUrl({ baseUrl })).toBe(DEFAULT);
    }
  });

  it("an empty ENGRAM_BASE_URL names no server: config.json's is used (engram#685)", async () => {
    const { resolveBaseUrl } = await import("../config.js");
    for (const env of ["", "   "]) {
      process.env.ENGRAM_BASE_URL = env;
      expect(resolveBaseUrl({ baseUrl: "http://staging.example.test" })).toBe("http://staging.example.test");
      expect(resolveBaseUrl({})).toBe(DEFAULT);
    }
    process.env.ENGRAM_BASE_URL = "  http://127.0.0.1:8788/  ";
    expect(resolveBaseUrl({ baseUrl: "http://staging.example.test" })).toBe("http://127.0.0.1:8788");
  });
});

describe("engram auth login checks the key where it will be used (engram#625)", () => {
  const authLogin = async (key = KEY) => {
    const { authLogin: run } = await import("../commands/auth.js");
    try {
      await run([key]);
      return null;
    } catch (err: unknown) {
      const m = /^exit (\d+)$/.exec(err instanceof Error ? err.message : "");
      if (!m) throw err;
      return Number(m[1]);
    }
  };

  it("at ENGRAM_BASE_URL when it is set, ahead of config.json", async () => {
    writeConfig({ baseUrl: "http://staging.example.test" });
    process.env.ENGRAM_BASE_URL = "http://127.0.0.1:8788";
    expect(await authLogin()).toBeNull();
    expect(clients).toEqual([{ baseUrl: "http://127.0.0.1:8788", apiKey: KEY }]);
    expect(readConfig()).toEqual({ baseUrl: "http://staging.example.test", apiKey: KEY });
  });

  it("at config.json's baseUrl when ENGRAM_BASE_URL isn't set", async () => {
    writeConfig({ baseUrl: "http://staging.example.test/" });
    expect(await authLogin()).toBeNull();
    expect(clients).toEqual([{ baseUrl: "http://staging.example.test", apiKey: KEY }]);
    expect(readConfig().apiKey).toBe(KEY);
  });

  it("at the default server when neither is set", async () => {
    expect(await authLogin()).toBeNull();
    expect(clients).toEqual([{ baseUrl: DEFAULT, apiKey: KEY }]);
    expect(readConfig()).toEqual({ apiKey: KEY });
  });

  it("a key the configured server refuses isn't saved, and nothing else is changed", async () => {
    writeConfig({ baseUrl: "http://staging.example.test", apiKey: "engram_sk_live_test_previous" });
    accepts = false;
    expect(await authLogin()).toBe(1);
    expect(clients.map((c) => c.baseUrl)).toEqual(["http://staging.example.test"]);
    expect(readConfig()).toEqual({ baseUrl: "http://staging.example.test", apiKey: "engram_sk_live_test_previous" });
    expect(out.join("\n")).toContain("Authentication failed");
  });
});

describe("the account commands use config.json's server too (engram#625)", () => {
  it("engram login signs in on config.json's server and saves that server's key", async () => {
    writeConfig({ baseUrl: "http://staging.example.test" });
    const { login } = await import("../commands/login.js");
    await login([], { email: "a@example.com", password: "pw-for-tests-only" });
    expect(requests.map((r) => r.url)).toEqual(["http://staging.example.test/signup/login"]);
    expect(readConfig()).toEqual({ baseUrl: "http://staging.example.test", apiKey: KEY });
  });

  it("engram usage sends the saved key only to config.json's server", async () => {
    writeConfig({ baseUrl: "http://staging.example.test", apiKey: KEY });
    const { fetchUsage } = await import("../commands/usage.js");
    await fetchUsage();
    expect(requests).toEqual([{ url: "http://staging.example.test/api/usage", auth: `Bearer ${KEY}` }]);
  });
});
