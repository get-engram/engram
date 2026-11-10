import { afterAll, describe, expect, it, vi } from "vitest";
import { lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * engram#669 — `engram stop` while the daemon is still starting. The socket
 * answers, and so `engram stop` finds the daemon and signals it, from the
 * moment it is bound: a while before the lock is decided (SETTLE_MS). A
 * signal with no handler then ends the process by that signal, which launchd
 * takes for a crash, and it starts the daemon again ten seconds later.
 *
 * A file of its own: the claim is made once per process, and here it is the
 * one a signal comes in the middle of. In a temp home, as in
 * daemon-claim.test.ts; the handlers the claim sets are called directly
 * (emitting a signal would reach vitest's own) and removed after.
 */

const { home } = vi.hoisted(() => ({ home: { dir: "" } }));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));

const POSIX = process.platform !== "win32";

// A socket path can be 103 bytes at most on macOS: a long TMPDIR won't do.
home.dir = mkdtempSync(join(!POSIX || Buffer.byteLength(tmpdir()) <= 60 ? tmpdir() : "/tmp", "e669-"));
const ENGRAM_DIR = join(home.dir, ".engram");
const SOCK = join(ENGRAM_DIR, "daemon.sock");
mkdirSync(ENGRAM_DIR, { recursive: true });

const { claimDaemonLock, pidInFile, probeDaemon, releaseDaemonLock, setStopHandler } = await import(
  "../daemon/instance.js"
);

const endpoint = { path: SOCK, pipe: false };
const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
const EVENTS = [...SIGNALS, "exit"];
const emitter: NodeJS.EventEmitter = process;
const listenersBefore = new Map(EVENTS.map((event) => [event, emitter.listeners(event)]));

afterAll(() => {
  releaseDaemonLock();
  for (const event of EVENTS) {
    const before = listenersBefore.get(event) ?? [];
    for (const listener of emitter.listeners(event)) {
      if (!before.includes(listener)) emitter.removeListener(event, listener as (...args: unknown[]) => void);
    }
  }
  rmSync(home.dir, { recursive: true, force: true });
});

/** The listeners on `event` that weren't there before this file claimed the lock. */
function added(event: string): Array<(...args: unknown[]) => void> {
  const before = listenersBefore.get(event) ?? [];
  return emitter.listeners(event).filter((listener) => !before.includes(listener)) as Array<(...args: unknown[]) => void>;
}

function isSocket(): boolean {
  try {
    return lstatSync(SOCK).isSocket();
  } catch {
    return false;
  }
}

describe.skipIf(!POSIX)("a stop that comes while the daemon takes its lock (engram#669)", () => {
  it("is acted on once the lock is decided: it lets its socket go, writes no PID file, and exits 0", async () => {
    const stopped = vi.fn();
    setStopHandler(stopped);
    const logs: string[] = [];
    let settled = false;
    const pending = claimDaemonLock({ log: (msg) => logs.push(msg), settleMs: 1_000, stopFile: false });
    void pending.then(() => (settled = true));

    // What `engram stop` does first: find the daemon by its socket.
    await vi.waitFor(
      async () => {
        const probe = await probeDaemon({ endpoint, timeoutMs: 500 });
        expect(probe).toMatchObject({ state: "answered", info: { pid: process.pid, ready: false } });
      },
      { timeout: 900, interval: 5 },
    );
    expect(settled).toBe(false);

    // Then signal it. Each signal it stops for has a handler by now, or the
    // signal would end the process outright.
    for (const signal of SIGNALS) {
      const handlers = added(signal);
      expect(handlers, signal).toHaveLength(1);
      handlers[0](signal);
    }
    // Nothing is let go of half decided: it waits for the lock.
    expect(stopped).not.toHaveBeenCalled();
    expect(isSocket()).toBe(true);

    expect(await pending).toEqual({ state: "stopped" });
    // The worker exits 0 on "stopped", so launchd leaves it stopped.
    expect(isSocket()).toBe(false);
    expect(pidInFile()).toBeNull();
    expect(added("exit")).toEqual([]);
    expect(logs).toEqual(["asked to stop while starting; this one is exiting"]);
    expect(stopped).not.toHaveBeenCalled();

    // Once decided, a signal goes to the stop handler as it would after a claim.
    added("SIGTERM")[0]("SIGTERM");
    expect(stopped).toHaveBeenCalledTimes(1);
  });
});
