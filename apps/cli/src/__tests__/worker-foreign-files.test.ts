import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ForeignFiles } from "../daemon/ownership.js";

/**
 * engram#659 — a daemon that finds files in ~/.engram it can't run with,
 * because `sudo engram …` left them root's, says which, and how to make them
 * the user's, and exits 0: launchd and systemd restart it only after a
 * failure, so it isn't started again into the same failure every few
 * seconds. The ones it can run with are only logged.
 *
 * In a temp home, with the lock, what is found in ~/.engram, and the desktop
 * notification mocked: nothing here takes the real daemon's lock, changes
 * the umask of this process, shows a notification, or touches the real
 * ~/.engram.
 */

const { home, found, shown } = vi.hoisted(() => ({
  home: { dir: "" },
  /** What foreignFiles finds. */
  found: { value: null as ForeignFiles | null },
  /** The notifications the worker waits for, and how to end the wait. */
  shown: { calls: [] as Array<[string, string]>, settle: () => {} },
}));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));

home.dir = mkdtempSync(join(tmpdir(), "engram-659w-"));

const { START_FAILED_EXIT } = await import("../daemon/supervise.js");
const { OWNERSHIP_FIX } = await import("../daemon/ownership.js");

/** What process.exit throws here, so the worker stops where it exits. */
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

/** The worker, from its lock (held) to where it stops. */
async function runWorker(): Promise<{ exit: ReturnType<typeof vi.spyOn>; log: () => string }> {
  vi.doMock("../daemon/instance.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../daemon/instance.js")>()),
    claimDaemonLock: vi.fn(async () => ({ state: "held" })),
  }));
  vi.doMock("../daemon/ownership.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../daemon/ownership.js")>()),
    foreignFiles: vi.fn(() => found.value),
  }));
  vi.doMock("../daemon/status.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../daemon/status.js")>()),
    notifyDesktopBeforeExit: vi.fn(
      (title: string, body: string) =>
        new Promise<void>((resolve) => {
          shown.calls.push([title, body]);
          shown.settle = resolve;
        }),
    ),
  }));
  // Past the check, the queue is opened: here it can't be, and the worker
  // stops there.
  vi.doMock("../daemon/db.js", () => ({
    DaemonDb: class {
      constructor() {
        throw new Error("no queue in this test");
      }
    },
  }));
  // A clean exit stops the worker where it is. Its catch then exits again,
  // with START_FAILED_EXIT, which is let be: so is any other exit.
  const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    if (code === 0) throw new Exited("exit 0");
  }) as never);
  const written = captureLog();
  await import("../daemon/worker-main.js");
  return { exit, log: () => written.join("") };
}

beforeEach(() => {
  shown.calls = [];
  shown.settle = () => {};
  // The worker sets a umask of 0o077: not on this process.
  vi.spyOn(process, "umask").mockReturnValue(0o022);
});

afterEach(() => {
  found.value = null;
  vi.restoreAllMocks();
  for (const path of ["instance", "ownership", "status", "db"]) vi.doUnmock(`../daemon/${path}.js`);
  vi.resetModules();
  rmSync(join(home.dir, ".engram"), { recursive: true, force: true });
});

afterAll(() => rmSync(home.dir, { recursive: true, force: true }));

describe("a daemon that finds files in ~/.engram it can't run with (engram#659)", () => {
  it("says which, and the fix, waits for the notification, and exits 0", async () => {
    found.value = {
      dir: false,
      files: ["daemon.db"],
      root: true,
      stopsDaemon: true,
      holdsSends: false,
    };
    const { exit, log } = await runWorker();
    await vi.waitFor(() => expect(shown.calls).toHaveLength(1));
    expect(shown.calls[0]).toEqual([
      "Engram capture has stopped",
      `Files in ~/.engram belong to root, not to you. To fix it, run: ${OWNERSHIP_FIX}`,
    ]);
    // launchd and systemd end what a job leaves running once it exits: the
    // notification is shown first.
    expect(exit).not.toHaveBeenCalled();
    shown.settle();
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    expect(exit.mock.calls[0]).toEqual([0]);
    expect(log()).toContain(
      "daemon exiting: daemon.db in ~/.engram belongs to root, not to you, so the daemon can't start, and nothing new is captured.\n",
    );
    expect(log()).toContain(`Make it yours with: ${OWNERSHIP_FIX}\n`);
    expect(log()).toContain("Then run: engram start\n");
    // It stopped before it set anything up.
    expect(log()).not.toContain("daemon started");
    expect(existsSync(join(home.dir, ".engram"))).toBe(false);
  });

  it("says another user, when the files aren't all root's", async () => {
    found.value = {
      dir: false,
      files: ["daemon.sock"],
      root: false,
      stopsDaemon: true,
      holdsSends: false,
    };
    const { exit, log } = await runWorker();
    await vi.waitFor(() => expect(shown.calls).toHaveLength(1));
    expect(shown.calls[0][1]).toBe(`Files in ~/.engram belong to another user, not to you. To fix it, run: ${OWNERSHIP_FIX}`);
    shown.settle();
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    expect(exit.mock.calls[0]).toEqual([0]);
    expect(log()).toContain("daemon exiting: daemon.sock in ~/.engram belongs to another user, not to you,");
  });

  it("runs on with what it can run with, and says so in the log", async () => {
    found.value = {
      dir: false,
      files: ["daemon.log", "status.json"],
      root: true,
      stopsDaemon: false,
      holdsSends: false,
    };
    const { exit, log } = await runWorker();
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    // It went on to open the queue, which this test doesn't let it.
    expect(exit.mock.calls[0]).toEqual([START_FAILED_EXIT]);
    expect(log()).toContain("fatal: no queue in this test");
    expect(log()).toContain(
      "warning: daemon.log and status.json in ~/.engram belong to root, not to you, so Engram can't update them. " +
        `Make them yours with: ${OWNERSHIP_FIX}\n`,
    );
    expect(log()).toContain("daemon started");
    expect(shown.calls).toEqual([]);
  });

  it("runs on with a vault key it can't read, which holds sends, and says so in the log (engram#695)", async () => {
    // What the check finds of a vault key that is root's, and 0600.
    const { foreignFiles } = await vi.importActual<typeof import("../daemon/ownership.js")>("../daemon/ownership.js");
    const dir = join(home.dir, ".engram");
    const isKey = (path: string) => path === join(dir, "vault-key");
    found.value = foreignFiles({
      platform: "linux",
      euid: 1000,
      env: {},
      dir,
      ownerOf: (path) => (isKey(path) ? 0 : path === dir ? 1000 : null),
      canAccess: (path) => !isKey(path),
    });
    expect(found.value).toMatchObject({ stopsDaemon: false, holdsSends: true });
    const { exit, log } = await runWorker();
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    // It went on to open the queue, which this test doesn't let it.
    expect(exit.mock.calls[0]).toEqual([START_FAILED_EXIT]);
    expect(log()).toContain(
      "warning: vault-key in ~/.engram belongs to root, not to you. Until it is yours, captured messages wait " +
        `on this machine: nothing is lost. Make it yours with: ${OWNERSHIP_FIX}\n`,
    );
    expect(log()).toContain("daemon started");
    expect(log()).not.toContain("daemon exiting");
    expect(shown.calls).toEqual([]);
  });

  it("says nothing of it when everything in ~/.engram is the user's", async () => {
    const { exit, log } = await runWorker();
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    expect(exit.mock.calls[0]).toEqual([START_FAILED_EXIT]);
    expect(log()).toContain("daemon started");
    expect(log()).not.toMatch(/not to you|daemon exiting/);
    expect(shown.calls).toEqual([]);
  });
});
