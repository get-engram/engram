import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// engram#594: when the account already had a key, `engram login` said
// "signed in" whatever account the key saved on this machine belonged to,
// and capture went on into that account. It may say so only when the saved
// key is the account's that signed in; otherwise nothing is changed.

const SAVED_KEY = "eng_test_saved_key_0123456789";
const EMAIL = "a@example.com";

type AccountReply = { status: number; body?: unknown } | Error;

let calls: Array<{ url: string; auth: string | null }>;
let out: string[];
let errs: string[];
let saveConfig: ReturnType<typeof vi.fn>;
let autoEnableCapture: ReturnType<typeof vi.fn>;
const savedBaseUrl = process.env.ENGRAM_BASE_URL;

/**
 * Run `engram login --email … --password …` against a server whose
 * /signup/login answers with `login`, and whose /api/account answers
 * `account` for the saved key.
 */
async function runLogin(opts: {
  login: { status: number; body?: unknown; raw?: string };
  account?: AccountReply;
  savedKey?: string;
  email?: string;
}): Promise<{ exit: number | null }> {
  vi.resetModules();
  vi.doMock("../config.js", () => ({
    loadConfig: async () => (opts.savedKey ? { apiKey: opts.savedKey } : {}),
    saveConfig,
    getBaseUrl: () => "http://127.0.0.1:9",
    resolveBaseUrl: () => "http://127.0.0.1:9",
  }));
  vi.doMock("../daemon/commands.js", () => ({ autoEnableCapture }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, auth: headers.get("authorization") });
      if (url.endsWith("/signup/login")) {
        const { status, body, raw } = opts.login;
        return new Response(raw ?? JSON.stringify(body ?? {}), { status });
      }
      if (url.endsWith("/api/account")) {
        const reply = opts.account;
        if (!reply) throw new Error("unexpected /api/account request");
        if (reply instanceof Error) throw reply;
        return new Response(
          typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {}),
          { status: reply.status },
        );
      }
      throw new Error(`unexpected request to ${url}`);
    }),
  );
  const { login } = await import("../commands/login.js");
  try {
    await login([], { email: opts.email ?? EMAIL, password: "pw-for-tests-only" });
    return { exit: null };
  } catch (err: unknown) {
    const m = /^exit (\d+)$/.exec(err instanceof Error ? err.message : "");
    if (!m) throw err;
    return { exit: Number(m[1]) };
  }
}

const conflict = (organizationId?: string) => ({
  status: 409,
  body: {
    error: "api_key_limit_reached",
    message: "This account already has the maximum number of API keys.",
    ...(organizationId ? { organization_id: organizationId } : {}),
  },
});
const account = (orgId: string, email: string | null) => ({
  status: 200,
  body: { org_id: orgId, email, name: null, tier: "free", deleted_at: null, purge_at: null },
});
const accountChecks = () => calls.filter((c) => c.url.endsWith("/api/account"));
const allOutput = () => [...out, ...errs].join("\n");

beforeEach(() => {
  delete process.env.ENGRAM_BASE_URL;
  calls = [];
  out = [];
  errs = [];
  saveConfig = vi.fn(async () => {});
  autoEnableCapture = vi.fn(async () => {});
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    out.push(a.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errs.push(a.map(String).join(" "));
  });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
});

afterEach(() => {
  if (savedBaseUrl === undefined) delete process.env.ENGRAM_BASE_URL;
  else process.env.ENGRAM_BASE_URL = savedBaseUrl;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock("../config.js");
  vi.doUnmock("../daemon/commands.js");
  vi.resetModules();
  // The saved key is never printed.
  expect(allOutput()).not.toContain(SAVED_KEY);
});

describe("engram login when the account already has a key (engram#594)", () => {
  it("signs in with the saved key when it is that account's, checked with the saved key", async () => {
    const r = await runLogin({
      login: conflict("org_A"),
      account: account("org_A", EMAIL),
      savedKey: SAVED_KEY,
    });
    expect(r.exit).toBeNull();
    expect(accountChecks()).toEqual([
      { url: "http://127.0.0.1:9/api/account", auth: `Bearer ${SAVED_KEY}` },
    ]);
    expect(out.join("\n")).toContain(`✓ Signed in as ${EMAIL}`);
    expect(out.join("\n")).toContain("Using existing API key from ~/.engram/config.json");
    expect(autoEnableCapture).toHaveBeenCalledTimes(1);
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it.each([
    ["an account with an email", "b@example.com", "another account (b@example.com)"],
    ["an account with no email", null, "another account (one with no email)"],
  ])(
    "refuses, changing nothing, when the saved key is %s of another account",
    async (_, otherEmail, named) => {
      const r = await runLogin({
        login: conflict("org_A"),
        account: account("org_B", otherEmail),
        savedKey: SAVED_KEY,
      });
      expect(r.exit).toBe(1);
      const text = errs.join("\n");
      expect(text).toContain(`belongs to ${named}, not ${EMAIL}.`);
      expect(text).toContain("Nothing was changed, and capture still goes to that account.");
      expect(text).toContain(`get a key for ${EMAIL} at getengram.app/dashboard`);
      expect(out.join("\n")).not.toContain("Signed in");
      expect(saveConfig).not.toHaveBeenCalled();
      expect(autoEnableCapture).not.toHaveBeenCalled();
    },
  );

  it("goes by the account id when the server names one, even where the emails match", async () => {
    const r = await runLogin({
      login: conflict("org_A"),
      account: account("org_other", EMAIL),
      savedKey: SAVED_KEY,
    });
    expect(r.exit).toBe(1);
    expect(errs.join("\n")).toContain(`belongs to another account (${EMAIL}), not ${EMAIL}.`);
    expect(autoEnableCapture).not.toHaveBeenCalled();
  });

  it("compares emails without regard to case or spaces when the server names no account id", async () => {
    const r = await runLogin({
      login: conflict(),
      account: account("org_A", "A@Example.COM"),
      savedKey: SAVED_KEY,
      email: "  a@EXAMPLE.com ",
    });
    expect(r.exit).toBeNull();
    expect(out.join("\n")).toContain(`✓ Signed in as a@EXAMPLE.com`);
    expect(autoEnableCapture).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["another email", "b@example.com"],
    ["no email", null],
  ])(
    "refuses when the server names no account id and the saved key's account has %s",
    async (_, otherEmail) => {
      const r = await runLogin({
        login: conflict(),
        account: account("org_A", otherEmail),
        savedKey: SAVED_KEY,
      });
      expect(r.exit).toBe(1);
      expect(errs.join("\n")).toContain("belongs to another account");
      expect(autoEnableCapture).not.toHaveBeenCalled();
      expect(saveConfig).not.toHaveBeenCalled();
    },
  );

  it("a 409 whose body isn't JSON falls back to comparing emails", async () => {
    const r = await runLogin({
      login: { status: 409, raw: "<html>conflict</html>" },
      account: account("org_A", EMAIL),
      savedKey: SAVED_KEY,
    });
    expect(r.exit).toBeNull();
    expect(autoEnableCapture).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "the server can't be reached",
      new TypeError("fetch failed"),
      "Couldn't check which account the saved API key belongs to (fetch failed).",
    ],
    [
      "the server fails",
      { status: 500, body: { error: "internal" } },
      "Couldn't check which account the saved API key belongs to (HTTP 500).",
    ],
    [
      "the saved key is rejected",
      { status: 401, body: { error: "unauthorized" } },
      "The API key saved in ~/.engram/config.json was rejected.",
    ],
    [
      "the answer isn't JSON",
      { status: 200, body: "<html>oops</html>" },
      "belongs to another account (one with no email)",
    ],
  ] as Array<[string, AccountReply, string]>)(
    "when %s, it says so and changes nothing",
    async (_, reply, said) => {
      const r = await runLogin({ login: conflict("org_A"), account: reply, savedKey: SAVED_KEY });
      expect(r.exit).toBe(1);
      expect(errs.join("\n")).toContain(said);
      expect(out.join("\n")).not.toContain("Signed in");
      expect(saveConfig).not.toHaveBeenCalled();
      expect(autoEnableCapture).not.toHaveBeenCalled();
    },
  );

  it("with no key saved, it says the account has one, and asks the server nothing more", async () => {
    const r = await runLogin({ login: conflict("org_A") });
    expect(r.exit).toBe(1);
    expect(errs.join("\n")).toContain("Your account already has an API key.");
    expect(accountChecks()).toEqual([]);
    expect(autoEnableCapture).not.toHaveBeenCalled();
  });

  it("a login that mints a key still saves it and enables capture", async () => {
    const minted = "eng_test_new_key_9876543210";
    const r = await runLogin({
      login: { status: 200, body: { organization_id: "org_A", api_key: minted } },
      savedKey: SAVED_KEY,
    });
    expect(r.exit).toBeNull();
    expect(saveConfig).toHaveBeenCalledWith({ apiKey: minted });
    expect(accountChecks()).toEqual([]);
    expect(autoEnableCapture).toHaveBeenCalledTimes(1);
    expect(allOutput()).not.toContain(minted);
  });
});
