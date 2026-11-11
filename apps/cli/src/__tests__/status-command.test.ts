import { afterEach, describe, expect, it, vi } from "vitest";
import type { LockedDir } from "../daemon/ownership.js";

// `engram status` shows the daemon on this machine, then the account's plan
// and usage (engram#609). It used to run `engram usage` alone, so offline it
// printed "Error: fetch failed" and never showed the daemon at all.
describe("engram status (engram#609)", () => {
  const savedKey = process.env.ENGRAM_API_KEY;

  afterEach(() => {
    if (savedKey === undefined) delete process.env.ENGRAM_API_KEY;
    else process.env.ENGRAM_API_KEY = savedKey;
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.doUnmock("../config.js");
    vi.doUnmock("../daemon/index.js");
    vi.doUnmock("../daemon/ownership.js");
    vi.resetModules();
  });

  const USAGE = {
    tier: "pro",
    period: null,
    messages: { used: 12, limit: -1 },
    storage: { used: 340, limit: -1 },
    searches: { used: 7 },
  };

  async function run(
    respond: () => Promise<Response>,
    {
      flags = {},
      apiKey = "eng_test_saved_key",
      unreadable,
      locked = null,
    }: {
      flags?: Record<string, string>;
      apiKey?: string | null;
      /** What is wrong with config.json, which then can't be read (engram#673). */
      unreadable?: string;
      /** What ~/.engram's own permissions keep the user from (engram#723). */
      locked?: LockedDir | null;
    } = {},
  ) {
    vi.resetModules();
    delete process.env.ENGRAM_API_KEY;
    const { ConfigUnreadable } = await import("../config-file.js");
    vi.doMock("../config.js", () => ({
      loadConfigStrict: async () => {
        if (unreadable) throw new ConfigUnreadable(unreadable);
        return apiKey ? { apiKey } : {};
      },
      resolveBaseUrl: () => "http://127.0.0.1:9",
    }));
    vi.doMock("../daemon/ownership.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../daemon/ownership.js")>()),
      lockedDir: () => locked,
    }));
    const lines: string[] = [];
    const daemonStatus = vi.fn(async () => {
      lines.push("out: Status: stopped");
    });
    vi.doMock("../daemon/index.js", () => ({ daemonStatus }));
    const fetchMock = vi.fn<typeof fetch>(respond);
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(`out: ${args.map(String).join(" ")}`);
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(`err: ${args.map(String).join(" ")}`);
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

    const { status } = await import("../commands/status.js");
    let thrown: unknown = null;
    try {
      await status([], flags);
    } catch (err) {
      thrown = err;
    }
    const exitCode = process.exitCode;
    process.exitCode = undefined;
    return {
      lines,
      text: lines.join("\n"),
      errors: lines.filter((l) => l.startsWith("err: ")).join("\n"),
      exitCode,
      thrown,
      daemonStatus,
      fetchMock,
    };
  }

  const ok = async () => new Response(JSON.stringify(USAGE), { status: 200 });

  it("shows the daemon first, then the plan and usage", async () => {
    const r = await run(ok);
    expect(r.thrown).toBeNull();
    expect(r.exitCode ?? 0).toBe(0);
    const daemonAt = r.lines.findIndex((l) => l.includes("Status: stopped"));
    const planAt = r.lines.findIndex((l) => l.includes("Plan:"));
    expect(daemonAt).toBeGreaterThanOrEqual(0);
    expect(planAt).toBeGreaterThan(daemonAt);
    expect(r.text).toContain("pro");
  });

  it("gives up on an API that doesn't answer, rather than hanging", async () => {
    const r = await run(ok);
    const init = r.fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("offline, shows the daemon and one line about usage, and succeeds", async () => {
    const r = await run(async () => {
      throw new TypeError("fetch failed");
    });
    expect(r.thrown).toBeNull();
    expect(r.exitCode ?? 0).toBe(0);
    expect(r.text).toContain("Status: stopped");
    expect(r.text).toContain("couldn't reach http://127.0.0.1:9");
    expect(r.errors).toBe("");
    expect(r.text).not.toContain("fetch failed");
  });

  it("a server error is one line too", async () => {
    const r = await run(async () => new Response("unavailable", { status: 503 }));
    expect(r.thrown).toBeNull();
    expect(r.exitCode ?? 0).toBe(0);
    expect(r.text).toContain("Status: stopped");
    expect(r.text).toContain("unavailable right now (503)");
    expect(r.errors).toBe("");
  });

  it.each([401, 403])("a %i still fails, after the daemon's status, and says how to fix it", async (code) => {
    const r = await run(async () => new Response('{"error":"unauthorized"}', { status: code }));
    expect(r.thrown).toBeNull();
    expect(r.exitCode).toBe(1);
    expect(r.text).toContain("Status: stopped");
    expect(r.errors).toContain("API key was rejected");
    expect(r.errors).toContain("engram auth login");
  });

  it("signed out, shows the daemon and fails with how to sign up", async () => {
    const r = await run(ok, { apiKey: null });
    expect(r.exitCode).toBe(1);
    expect(r.text).toContain("Status: stopped");
    expect(r.errors).toContain("Not authenticated");
    expect(r.fetchMock).not.toHaveBeenCalled();
  });

  // What is wrong is said above it, with the daemon: the line says only
  // what the plan waits for, and the command fails, as the API key can't
  // be told.
  const FILE_LINE = "Plan and usage: can't be shown until ~/.engram/config.json can be read.";
  it.each<[string, string, LockedDir | null, string]>([
    ["a config.json that can't be read (engram#673)", "isn't valid JSON", null, FILE_LINE],
    [
      "a ~/.engram that can't be searched (engram#723)",
      "can't be read: permission denied",
      { search: true, write: false, command: "chmod u+x ~/.engram" },
      "Plan and usage: can't be shown until the files in ~/.engram can be opened.",
    ],
    [
      "a ~/.engram that only can't be written, with a config.json that can't be read",
      "can't be read: permission denied",
      { search: false, write: true, command: "chmod u+w ~/.engram" },
      FILE_LINE,
    ],
  ])("%s: one line, after the daemon's status, and exits 1", async (_what, unreadable, locked, line) => {
    const r = await run(ok, { unreadable, locked });
    expect(r.thrown).toBeNull();
    expect(r.exitCode).toBe(1);
    expect(r.lines).toEqual(["out: Status: stopped", `out: \n${line}`]);
    expect(r.fetchMock).not.toHaveBeenCalled();
  });

  it("--json prints only the usage JSON that scripts already parse", async () => {
    const r = await run(ok, { flags: { json: "" } });
    expect(r.daemonStatus).not.toHaveBeenCalled();
    const out = r.lines.filter((l) => l.startsWith("out: ")).map((l) => l.slice(5)).join("\n");
    expect(JSON.parse(out)).toEqual(USAGE);
  });

  it("--json still fails loudly when usage can't be fetched", async () => {
    const r = await run(async () => {
      throw new TypeError("fetch failed");
    }, { flags: { json: "" } });
    expect(String(r.thrown)).toContain("exit 1");
    expect(r.errors).toContain("Couldn't reach Engram at http://127.0.0.1:9");
  });
});
