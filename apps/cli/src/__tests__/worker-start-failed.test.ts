import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * engram#613 — a worker that fails before it is ready exits with
 * START_FAILED_EXIT, and never with 1: the Windows supervisor then lets
 * `engram start` report the failure, rather than starting it again while
 * `engram start` says it is starting.
 *
 * In a temp home, with the lock and the preflight mocked: nothing here takes
 * the real daemon's lock, rebuilds a native module, or touches the real
 * ~/.engram.
 */

const { home } = vi.hoisted(() => ({ home: { dir: "" } }));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));

home.dir = mkdtempSync(join(tmpdir(), "engram-613w-"));

const { START_FAILED_EXIT } = await import("../daemon/supervise.js");

/** What process.exit throws here, so the module that called it stops there. */
class Exited extends Error {}

/** What the worker logs, in place of stderr. */
function captureLog(): string[] {
  const written: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  }) as never);
  return written;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("../daemon/instance.js");
  vi.doUnmock("../daemon/preflight.js");
  vi.resetModules();
});

afterAll(() => rmSync(home.dir, { recursive: true, force: true }));

describe("a worker that fails before it is ready (engram#613)", () => {
  it("exits with START_FAILED_EXIT when its preflight fails", async () => {
    vi.doMock("../daemon/instance.js", () => ({ claimDaemonLock: vi.fn(async () => ({ state: "held" })) }));
    vi.doMock("../daemon/preflight.js", () => ({ ensureNativeSqlite: vi.fn(() => false) }));
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Exited(`exit ${code}`);
    }) as never);
    const written = captureLog();
    await expect(import("../daemon/worker.js")).rejects.toThrow(Exited);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(START_FAILED_EXIT);
    expect(written.join("")).toContain("daemon exiting: native sqlite unavailable");
  });

  it("exits with START_FAILED_EXIT when its setup fails", async () => {
    vi.doMock("../daemon/instance.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../daemon/instance.js")>()),
      claimDaemonLock: vi.fn(async () => {
        throw new Error("no lock to be had");
      }),
    }));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const written = captureLog();
    await import("../daemon/worker-main.js");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(START_FAILED_EXIT));
    expect(exit).toHaveBeenCalledTimes(1);
    expect(written.join("")).toContain("fatal: no lock to be had");
    // It failed before it set anything up.
    expect(existsSync(join(home.dir, ".engram"))).toBe(false);
  });
});

describe("a worker running as root for the user (engram#680)", () => {
  const REFUSED = {
    state: "refused",
    message: "daemon exiting: it runs as root, and Engram's daemon runs as you. Run 'engram start' as yourself, without sudo",
  };

  it("exits 0, which launchd leaves stopped, before its preflight", async () => {
    vi.doMock("../daemon/instance.js", () => ({ claimDaemonLock: vi.fn(async () => REFUSED) }));
    const ensureNativeSqlite = vi.fn(() => true);
    vi.doMock("../daemon/preflight.js", () => ({ ensureNativeSqlite }));
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Exited(`exit ${code}`);
    }) as never);
    captureLog();
    await expect(import("../daemon/worker.js")).rejects.toThrow(Exited);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(ensureNativeSqlite).not.toHaveBeenCalled();
  });

  it("exits 0 before it sets anything up, when a plist from before 0.4.2 starts worker-main.js", async () => {
    vi.doMock("../daemon/instance.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../daemon/instance.js")>()),
      claimDaemonLock: vi.fn(async () => REFUSED),
    }));
    const umask = vi.spyOn(process, "umask");
    // The first exit stops main() where it is. The one after, which main()'s
    // catch makes of that throw, does nothing: waited for, so it never
    // reaches the real process.exit once the mocks are restored.
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementationOnce(((code?: number) => {
        throw new Exited(`exit ${code}`);
      }) as never)
      .mockImplementation((() => undefined) as never);
    captureLog();
    await import("../daemon/worker-main.js");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(2));
    expect(exit.mock.calls[0]).toEqual([0]);
    expect(umask).not.toHaveBeenCalled();
    expect(existsSync(join(home.dir, ".engram"))).toBe(false);
  });
});
