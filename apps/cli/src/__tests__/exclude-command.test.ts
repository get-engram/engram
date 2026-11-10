import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeExcludePath } from "../daemon/exclusions.js";

// `engram exclude add` and `remove` treat two spellings of one directory as
// one entry where the file system does (engram#619): on macOS and Windows,
// ~/Code/Client and ~/code/client are the same directory.
describe("engram exclude add/remove (engram#619)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../config.js");
    vi.resetModules();
  });

  async function setup(excludePaths: string[]) {
    vi.resetModules();
    const store: { excludePaths?: string[] } = { excludePaths: [...excludePaths] };
    vi.doMock("../config.js", () => ({
      loadConfigStrict: async () => ({ excludePaths: [...(store.excludePaths ?? [])] }),
      saveConfig: async (c: { excludePaths?: string[] }) => {
        store.excludePaths = c.excludePaths;
      },
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const commands = await import("../commands/exclude.js");
    return { store, ...commands };
  }

  const stored = normalizeExcludePath("/srv/work/Client");
  const otherCase = "/srv/work/client";
  const caseInsensitive = process.platform === "darwin" || process.platform === "win32";

  it("adds a directory once, however often it's added", async () => {
    const { store, excludeAdd } = await setup([]);
    await excludeAdd([stored]);
    await excludeAdd([stored + "/"]);
    expect(store.excludePaths).toEqual([stored]);
  });

  it.runIf(caseInsensitive)("treats another case of an excluded directory as the same entry", async () => {
    const { store, excludeAdd, excludeRemove } = await setup([stored]);
    await excludeAdd([otherCase]);
    expect(store.excludePaths).toEqual([stored]);
    await excludeRemove([otherCase]);
    expect(store.excludePaths).toEqual([]);
  });

  it.runIf(!caseInsensitive)("keeps directories that differ in case apart where case matters", async () => {
    const { store, excludeAdd } = await setup([stored]);
    await excludeAdd([otherCase]);
    expect(store.excludePaths).toHaveLength(2);
  });
});
