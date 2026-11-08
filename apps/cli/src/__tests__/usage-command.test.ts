import { afterEach, describe, expect, it, vi } from "vitest";

// `engram status` runs the usage command, and it is where every rejected-key
// notice from the daemon points (engram#587).
describe("engram status with a rejected key (engram#587)", () => {
  const savedKey = process.env.ENGRAM_API_KEY;

  afterEach(() => {
    if (savedKey === undefined) delete process.env.ENGRAM_API_KEY;
    else process.env.ENGRAM_API_KEY = savedKey;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.doUnmock("../config.js");
    vi.resetModules();
  });

  async function runUsage(status: number): Promise<string> {
    vi.resetModules();
    vi.doMock("../config.js", () => ({
      loadConfig: async () => ({ apiKey: "eng_test_saved_key" }),
      getBaseUrl: () => "http://127.0.0.1:9",
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"error":"unauthorized"}', { status })),
    );
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const { usage } = await import("../commands/usage.js");
    await expect(usage([], {})).rejects.toThrow("exit 1");
    return errors.join("\n");
  }

  it.each([401, 403])("a %i says the key was rejected and how to replace it", async (status) => {
    delete process.env.ENGRAM_API_KEY;
    const out = await runUsage(status);
    expect(out).toContain("API key was rejected");
    expect(out).toContain("engram auth login");
    expect(out).not.toContain(String(status));
    expect(out).not.toContain("ENGRAM_API_KEY");
  });

  it("says when ENGRAM_API_KEY is the key in use, since logging in won't replace it", async () => {
    process.env.ENGRAM_API_KEY = "eng_test_env_key";
    const out = await runUsage(401);
    expect(out).toContain("API key was rejected");
    expect(out).toContain("ENGRAM_API_KEY is set");
    expect(out).not.toContain("eng_test_env_key");
  });

  it("other failures still report their status", async () => {
    delete process.env.ENGRAM_API_KEY;
    const out = await runUsage(500);
    expect(out).toContain("Failed to fetch usage (500)");
    expect(out).not.toContain("rejected");
  });
});
