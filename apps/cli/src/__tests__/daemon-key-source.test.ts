import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// engram#594: the daemon reads its API key from config.json every couple of
// seconds, and treats "no key" as a logout. A config.json it can't read must
// not look like one. And the one request that asks the server which earlier
// keys are this account's sends key fingerprints only, never a key.
//
// engram#685: the key and its server come from the same read of the file,
// and the earlier-keys check goes to that server.

const { home } = vi.hoisted(() => ({ home: { dir: "" } }));

// config.ts reads ~/.engram/config.json: point it at a temp home.
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));

home.dir = mkdtempSync(join(tmpdir(), "engram-594-key-"));
const CONFIG = join(home.dir, ".engram", "config.json");

const { configuredAccount, ownedKeysAt, ownedKeysOf, OWNED_KEYS_BATCH } = await import("../daemon/key-source.js");
const { DEFAULT_BASE_URL } = await import("../server-url.js");

process.on("exit", () => rmSync(home.dir, { recursive: true, force: true }));

const saved = { key: process.env.ENGRAM_API_KEY, server: process.env.ENGRAM_BASE_URL };
const restoreEnv = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

const writeConfig = (text: string) => {
  mkdirSync(join(home.dir, ".engram"), { recursive: true });
  writeFileSync(CONFIG, text);
};

beforeEach(() => {
  rmSync(join(home.dir, ".engram"), { recursive: true, force: true });
  delete process.env.ENGRAM_API_KEY;
  delete process.env.ENGRAM_BASE_URL;
});

afterEach(() => {
  restoreEnv("ENGRAM_API_KEY", saved.key);
  restoreEnv("ENGRAM_BASE_URL", saved.server);
});

describe("configuredAccount: the key in config.json (engram#594)", () => {
  it("is the saved key", async () => {
    writeConfig(JSON.stringify({ apiKey: "engram_sk_test_1", baseUrl: "http://localhost:8787" }));
    await expect(configuredAccount()).resolves.toMatchObject({ key: "engram_sk_test_1" });
  });

  it("no config.json, no apiKey, or an empty or null one is no key: signed out", async () => {
    await expect(configuredAccount()).resolves.toBeUndefined();
    for (const config of [{}, { apiKey: "" }, { apiKey: null }, { baseUrl: "http://localhost:8787" }]) {
      writeConfig(JSON.stringify(config));
      await expect(configuredAccount()).resolves.toBeUndefined();
    }
  });

  it("a config.json caught half-written, or damaged, throws instead of reading as a logout", async () => {
    writeConfig('{"apiKey": "engram_sk_te');
    // What it says never quotes the file: the key is in it (engram#673).
    const half = await configuredAccount().then(
      () => null,
      (err: unknown) => err,
    );
    expect(half).toBeInstanceOf(Error);
    expect((half as Error).message).toContain("isn't valid JSON");
    expect((half as Error).message).not.toContain("engram_sk_te");
    writeConfig("");
    await expect(configuredAccount()).rejects.toThrow("is empty");
    writeConfig("[]");
    await expect(configuredAccount()).rejects.toThrow("isn't a JSON object");
    writeConfig("null");
    await expect(configuredAccount()).rejects.toThrow("isn't a JSON object");
  });

  it("an apiKey that isn't a string throws", async () => {
    writeConfig(JSON.stringify({ apiKey: 42 }));
    await expect(configuredAccount()).rejects.toThrow("apiKey is not a string");
    writeConfig(JSON.stringify({ apiKey: ["engram_sk_test_1"] }));
    await expect(configuredAccount()).rejects.toThrow("apiKey is not a string");
  });

  it("a config.json that exists but can't be read throws", async () => {
    // A directory where the file should be: readFile fails with EISDIR,
    // as it does with EACCES, whoever the tests run as.
    mkdirSync(CONFIG, { recursive: true });
    await expect(configuredAccount()).rejects.toThrow();
  });
});

describe("configuredAccount: the key's server comes from the same read (engram#685)", () => {
  it("is config.json's baseUrl, or the default server when it names none", async () => {
    writeConfig(JSON.stringify({ apiKey: "engram_sk_test_1", baseUrl: "http://localhost:8787/" }));
    await expect(configuredAccount()).resolves.toEqual({ key: "engram_sk_test_1", server: "http://localhost:8787" });
    for (const baseUrl of [undefined, "", "   ", 42]) {
      writeConfig(JSON.stringify({ apiKey: "engram_sk_test_1", baseUrl }));
      await expect(configuredAccount()).resolves.toEqual({ key: "engram_sk_test_1", server: DEFAULT_BASE_URL });
    }
  });

  it("ENGRAM_BASE_URL names the server ahead of config.json, and the key still comes from the file", async () => {
    process.env.ENGRAM_BASE_URL = "http://127.0.0.1:8701";
    writeConfig(JSON.stringify({ apiKey: "engram_sk_test_1", baseUrl: "http://localhost:8787" }));
    await expect(configuredAccount()).resolves.toEqual({ key: "engram_sk_test_1", server: "http://127.0.0.1:8701" });
  });

  it("an empty ENGRAM_BASE_URL names no server: config.json's is used", async () => {
    writeConfig(JSON.stringify({ apiKey: "engram_sk_test_1", baseUrl: "http://localhost:8787" }));
    for (const value of ["", "  "]) {
      process.env.ENGRAM_BASE_URL = value;
      await expect(configuredAccount()).resolves.toEqual({ key: "engram_sk_test_1", server: "http://localhost:8787" });
    }
  });

  it("with only ENGRAM_API_KEY set, the server is still config.json's, so a file that can't be read throws", async () => {
    process.env.ENGRAM_API_KEY = "engram_sk_test_env";
    writeConfig(JSON.stringify({ apiKey: "engram_sk_test_1", baseUrl: "http://localhost:8787" }));
    await expect(configuredAccount()).resolves.toEqual({ key: "engram_sk_test_env", server: "http://localhost:8787" });

    // Not the default server: the key would go where the user didn't send it.
    writeConfig('{"apiKey": "engram_sk_te');
    await expect(configuredAccount()).rejects.toThrow("isn't valid JSON");
    rmSync(CONFIG);
    mkdirSync(CONFIG);
    await expect(configuredAccount()).rejects.toThrow();

    // No config.json at all is no settings: the default server.
    rmSync(join(home.dir, ".engram"), { recursive: true, force: true });
    await expect(configuredAccount()).resolves.toEqual({ key: "engram_sk_test_env", server: DEFAULT_BASE_URL });
  });

  it("with ENGRAM_API_KEY and ENGRAM_BASE_URL both set, config.json isn't read", async () => {
    process.env.ENGRAM_API_KEY = "engram_sk_test_env";
    process.env.ENGRAM_BASE_URL = "http://127.0.0.1:8701/";
    mkdirSync(CONFIG, { recursive: true });
    await expect(configuredAccount()).resolves.toEqual({ key: "engram_sk_test_env", server: "http://127.0.0.1:8701" });
  });

  it("an empty ENGRAM_API_KEY is no key: config.json's is used", async () => {
    process.env.ENGRAM_API_KEY = "";
    process.env.ENGRAM_BASE_URL = "http://127.0.0.1:8701";
    writeConfig(JSON.stringify({ apiKey: "engram_sk_test_1" }));
    await expect(configuredAccount()).resolves.toEqual({ key: "engram_sk_test_1", server: "http://127.0.0.1:8701" });
  });
});

/** A fetch that answers each owned-keys request with `respond`. */
function fakeFetch(respond: (hashes: string[]) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit; hashes: string[] }> = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const hashes = (JSON.parse(String(init?.body)) as { key_hashes: string[] }).key_hashes;
    calls.push({ url: String(url), init: init ?? {}, hashes });
    return respond(hashes);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const hash = (i: number) => i.toString(16).padStart(64, "0");
const KEY = "engram_sk_test_current";

describe("ownedKeysAt: which earlier keys are this account's (engram#594)", () => {
  it("asks in batches of the server's cap, authenticated by the key, with fingerprints only", async () => {
    const hashes = Array.from({ length: 2 * OWNED_KEYS_BATCH + 20 }, (_, i) => hash(i + 1));
    // The account owns every third key asked about.
    const { fetch, calls } = fakeFetch((asked) =>
      json({ owned: asked.filter((h) => parseInt(h, 16) % 3 === 0) }),
    );

    const owned = await ownedKeysAt("https://engram.test/", fetch)(KEY, hashes);

    expect(calls.map((c) => c.hashes.length)).toEqual([OWNED_KEYS_BATCH, OWNED_KEYS_BATCH, 20]);
    expect(calls.flatMap((c) => c.hashes)).toEqual(hashes);
    for (const c of calls) {
      expect(c.url).toBe("https://engram.test/api/account/owned-keys");
      expect(c.init.method).toBe("POST");
      expect(new Headers(c.init.headers).get("Authorization")).toBe(`Bearer ${KEY}`);
      // The key only authenticates: it is never in what is asked.
      expect(String(c.init.body)).not.toContain(KEY);
      expect(Object.keys(JSON.parse(String(c.init.body)))).toEqual(["key_hashes"]);
    }
    expect(owned).toEqual(hashes.filter((h) => parseInt(h, 16) % 3 === 0));
  });

  it("nothing to ask about makes no request", async () => {
    const { fetch, calls } = fakeFetch(() => json({ owned: [] }));
    await expect(ownedKeysAt("https://engram.test", fetch)(KEY, [])).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("only a hash that was asked about can come back as this account's", async () => {
    const asked = [hash(1), hash(2)];
    const { fetch } = fakeFetch(() => json({ owned: [hash(2), hash(99), 7, null, { h: hash(1) }] }));
    await expect(ownedKeysAt("https://engram.test", fetch)(KEY, asked)).resolves.toEqual([hash(2)]);
  });

  it("a refusal throws with its HTTP status, which the syncer acts on", async () => {
    for (const status of [400, 401, 403, 404, 429, 500, 503]) {
      const { fetch } = fakeFetch(() => json({ error: "nope" }, status));
      const err = await ownedKeysAt("https://engram.test", fetch)(KEY, [hash(1)]).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as { status?: number }).status).toBe(status);
      expect((err as Error).message).toContain(`HTTP ${status}`);
    }
  });

  it("a long refusal body is cut short in the error", async () => {
    const { fetch } = fakeFetch(() => new Response("x".repeat(5_000), { status: 502 }));
    const err = (await ownedKeysAt("https://engram.test", fetch)(KEY, [hash(1)]).catch(
      (e: unknown) => e,
    )) as Error;
    expect(err.message.length).toBeLessThan(400);
  });

  it("an answer it can't read throws without a status, so the syncer asks again later", async () => {
    for (const respond of [
      () => json({}),
      () => json({ owned: "all" }),
      () => new Response("<html>gateway</html>", { status: 200 }),
    ]) {
      const { fetch } = fakeFetch(respond);
      const err = (await ownedKeysAt("https://engram.test", fetch)(KEY, [hash(1)]).catch(
        (e: unknown) => e,
      )) as Error & { status?: number };
      expect(err).toBeInstanceOf(Error);
      expect(err.status).toBeUndefined();
    }
  });

  it("a failure part-way through the batches throws, not a partial answer", async () => {
    const hashes = Array.from({ length: OWNED_KEYS_BATCH + 1 }, (_, i) => hash(i + 1));
    let n = 0;
    const { fetch } = fakeFetch((asked) => (++n === 1 ? json({ owned: asked }) : json({}, 503)));
    await expect(ownedKeysAt("https://engram.test", fetch)(KEY, hashes)).rejects.toMatchObject({
      status: 503,
    });
  });

  it("ownedKeysOf asks the account's own server, with the account's key (engram#685)", async () => {
    const { fetch, calls } = fakeFetch((asked) => json({ owned: asked }));
    const ask = ownedKeysOf(fetch);
    await expect(ask({ key: KEY, server: "http://127.0.0.1:8701/" }, [hash(1)])).resolves.toEqual([hash(1)]);
    await expect(ask({ key: "engram_sk_test_other", server: "http://127.0.0.1:8702" }, [hash(2)])).resolves.toEqual([
      hash(2),
    ]);
    expect(calls.map((c) => [c.url, new Headers(c.init.headers).get("Authorization")])).toEqual([
      ["http://127.0.0.1:8701/api/account/owned-keys", `Bearer ${KEY}`],
      ["http://127.0.0.1:8702/api/account/owned-keys", "Bearer engram_sk_test_other"],
    ]);
  });

  it("a network failure rejects as it is (no status)", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const err = (await ownedKeysAt("https://engram.test", fetch)(KEY, [hash(1)]).catch(
      (e: unknown) => e,
    )) as Error & { status?: number };
    expect(err.message).toBe("fetch failed");
    expect(err.status).toBeUndefined();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
