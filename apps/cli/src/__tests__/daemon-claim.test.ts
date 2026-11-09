import { afterAll, describe, expect, it, vi } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateFileSync } from "../private-files.js";

/**
 * engram#612 — the daemon's hold on its socket, as the worker takes it:
 * claimDaemonLock, then checkDaemonLock, which the daemon runs every 30
 * seconds. In a temp home: the PID file and the socket are this test's own,
 * and nothing reaches the real ~/.engram or a running daemon.
 *
 * The claim sets SIGTERM, SIGINT, SIGHUP and exit handlers on this process.
 * What they do is set to nothing that exits, and they are removed after. It
 * also looks for a stop request (engram#613) every second, in this test's
 * ~/.engram.
 *
 * POSIX only: a named pipe can't be removed from under the daemon.
 */

const { home } = vi.hoisted(() => ({ home: { dir: "" } }));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));

const POSIX = process.platform !== "win32";

// A socket path can be 103 bytes at most on macOS: a long TMPDIR won't do.
home.dir = mkdtempSync(join(!POSIX || Buffer.byteLength(tmpdir()) <= 60 ? tmpdir() : "/tmp", "e612c-"));
const ENGRAM_DIR = join(home.dir, ".engram");
const PID_FILE = join(ENGRAM_DIR, "daemon.pid");
const SOCK = join(ENGRAM_DIR, "daemon.sock");
const STOP_FILE = join(ENGRAM_DIR, "daemon.stop");
mkdirSync(ENGRAM_DIR, { recursive: true });

const {
  checkDaemonLock,
  checkStopRequest,
  claimDaemonLock,
  markReady,
  pidInFile,
  probeDaemon,
  releaseDaemonLock,
  setDisplacedHandler,
  setStopHandler,
} = await import("../daemon/instance.js");

const endpoint = { path: SOCK, pipe: false };
const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
const EVENTS = [...SIGNALS, "exit"];
const emitter: NodeJS.EventEmitter = process;
const listenersBefore = new Map(EVENTS.map((event) => [event, emitter.listeners(event)]));
const logs: string[] = [];
const displaced = vi.fn();
const stopped = vi.fn();
const holders: Array<{ stop: () => Promise<void> }> = [];

afterAll(async () => {
  for (const h of holders.splice(0)) await h.stop();
  releaseDaemonLock();
  for (const event of EVENTS) {
    const before = listenersBefore.get(event) ?? [];
    for (const listener of emitter.listeners(event)) {
      if (!before.includes(listener)) emitter.removeListener(event, listener as (...args: unknown[]) => void);
    }
  }
  rmSync(home.dir, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The listeners on `event` that weren't there before this test file claimed the lock. */
function added(event: string): Array<(...args: unknown[]) => void> {
  const before = listenersBefore.get(event) ?? [];
  return emitter.listeners(event).filter((listener) => !before.includes(listener)) as Array<(...args: unknown[]) => void>;
}

/** The inode of the socket file at ~/.engram/daemon.sock, or null when there is none. */
function inode(): number | null {
  try {
    const st = lstatSync(SOCK);
    return st.isSocket() ? st.ino : null;
  } catch {
    return null;
  }
}

/** The PID that answers on ~/.engram/daemon.sock, or null when nothing does. */
async function answersAs(): Promise<number | null> {
  const probe = await probeDaemon({ endpoint, timeoutMs: 1_000 });
  return probe.state === "answered" ? probe.info.pid : null;
}

/** Another daemon (pid 4242) listening on ~/.engram/daemon.sock, answering with `fields`. */
async function holder(fields: Record<string, unknown>): Promise<{ stop: () => Promise<void> }> {
  const open = new Set<Socket>();
  const line = `${JSON.stringify({
    engram: "daemon",
    protocol: 1,
    pid: 4242,
    version: "0.7.0",
    started_at: "2026-11-09T10:00:00.000Z",
    id: "0".repeat(32),
    ready: true,
    stopping: false,
    ...fields,
  })}\n`;
  const server = createServer((socket) => {
    socket.on("error", () => {});
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    socket.end(line);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(SOCK, () => {
      server.off("error", reject);
      resolve();
    });
  });
  let closed: Promise<void> | null = null;
  const h = {
    // Closing removes the socket file at the path, by name: it is this one's.
    stop: () =>
      (closed ??= new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        server.close(() => resolve());
      })),
  };
  holders.push(h);
  return h;
}

/** A socket file nothing listens on, as a daemon that was killed leaves it. */
async function staleSocket(): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(SOCK, () => resolve());
  });
  renameSync(SOCK, `${SOCK}.aside`);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  renameSync(`${SOCK}.aside`, SOCK);
}

const AGAIN = "~/.engram/daemon.sock was removed; listening on it again";

// In order: each test starts where the last left the lock.
describe.skipIf(!POSIX)("the daemon's hold on its socket", () => {
  it("takes the lock: the socket answers as this process, and the PID file names it", async () => {
    setStopHandler(stopped);
    setDisplacedHandler(displaced);
    const claim = await claimDaemonLock({ log: (msg) => logs.push(msg), settleMs: 20, stopFile: true });
    expect(claim).toEqual({ state: "held" });
    expect(await claimDaemonLock({ log: () => {} })).toBe(claim);
    expect(pidInFile()).toBe(process.pid);
    expect(inode()).not.toBeNull();
    expect(lstatSync(SOCK).mode & 0o077).toBe(0);
    expect(await probeDaemon({ endpoint })).toMatchObject({
      state: "answered",
      info: { pid: process.pid, ready: false, stopping: false, stopFile: true },
    });
    markReady();
    expect(await probeDaemon({ endpoint })).toMatchObject({ state: "answered", info: { ready: true } });
    expect(logs).toEqual([]);
  });

  it("a check with everything in place changes nothing", async () => {
    const before = inode();
    await checkDaemonLock();
    expect(inode()).toBe(before);
    expect(pidInFile()).toBe(process.pid);
    expect(logs).toEqual([]);
  });

  it("stops when a stop request names it, by its PID and its id, once for each request (engram#613)", async () => {
    const probe = await probeDaemon({ endpoint });
    const id = probe.state === "answered" ? probe.info.id : undefined;
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    // No await from here on: the daemon's own look, every second, can't come
    // between a write and the check after it.
    for (const request of [
      // An earlier daemon's, whose PID this one has since: never its id.
      JSON.stringify({ pid: process.pid, id: "0".repeat(32) }),
      JSON.stringify({ pid: 4242, id }),
      // From an `engram stop` that found no daemon running.
      JSON.stringify({ pid: null }),
      "not json",
    ]) {
      writePrivateFileSync(STOP_FILE, request);
      checkStopRequest();
    }
    expect(stopped).not.toHaveBeenCalled();
    writePrivateFileSync(STOP_FILE, JSON.stringify({ pid: process.pid, id }));
    checkStopRequest();
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(logs.splice(0)).toEqual(["stop requested ('engram stop')"]);
    // Read once: a daemon still finishing its send isn't asked again.
    checkStopRequest();
    expect(stopped).toHaveBeenCalledTimes(1);
    stopped.mockClear();
  });

  it("removes the request it stopped for after a clean exit, and keeps it after an error, for the supervisor (engram#613)", () => {
    const onExit = added("exit").filter((listener) => listener !== releaseDaemonLock);
    expect(onExit).toHaveLength(1);
    const exit = (code: number): void => onExit[0](code);
    // The request the last test stopped it with is still there.
    exit(1);
    expect(existsSync(STOP_FILE)).toBe(true);
    writePrivateFileSync(STOP_FILE, JSON.stringify({ pid: 4242, id: "0".repeat(32) }));
    exit(0);
    expect(existsSync(STOP_FILE)).toBe(true);
    writePrivateFileSync(STOP_FILE, JSON.stringify({ pid: process.pid, id: "0".repeat(32) }));
    exit(0);
    expect(existsSync(STOP_FILE)).toBe(false);
  });

  it("stops on SIGTERM, SIGINT and SIGHUP, as when the console it runs in is closed", () => {
    // Called directly: emitting a signal would reach vitest's handlers too.
    for (const signal of SIGNALS) {
      const handlers = added(signal);
      expect(handlers, signal).toHaveLength(1);
      handlers[0](signal);
    }
    expect(stopped).toHaveBeenCalledTimes(SIGNALS.length);
    stopped.mockClear();
    expect(logs).toEqual([]);
  });

  it("writes the PID file again when it is gone, or names another process", async () => {
    rmSync(PID_FILE);
    await checkDaemonLock();
    expect(pidInFile()).toBe(process.pid);
    writeFileSync(PID_FILE, "4242\n");
    await checkDaemonLock();
    expect(pidInFile()).toBe(process.pid);
  });

  it("listens again when its socket was removed", async () => {
    const before = inode();
    unlinkSync(SOCK);
    expect(await answersAs()).toBeNull();
    await checkDaemonLock();
    expect(await answersAs()).toBe(process.pid);
    expect(inode()).not.toBe(before);
    expect(logs.splice(0)).toEqual([AGAIN]);
  });

  it("removes a dead daemon's socket found in its place, and listens again", async () => {
    unlinkSync(SOCK);
    await staleSocket();
    await checkDaemonLock();
    expect(await answersAs()).toBe(process.pid);
    expect(logs.splice(0)).toEqual(["removed a daemon.sock left by a daemon that didn't exit cleanly", AGAIN]);
  });

  it("goes on beside a daemon there that is starting, or stopping, and listens again once it has gone", async () => {
    for (const fields of [{ ready: false }, { ready: true, stopping: true }]) {
      unlinkSync(SOCK);
      const other = await holder(fields);
      await checkDaemonLock();
      expect(await answersAs()).toBe(4242);
      await other.stop();
      await checkDaemonLock();
      expect(await answersAs()).toBe(process.pid);
    }
    expect(displaced).not.toHaveBeenCalled();
    expect(logs.splice(0)).toEqual([AGAIN, AGAIN]);
  });

  it("goes on when a starting worker binds while it clears a dead socket", async () => {
    // The worker's bind lands while the check waits to remove a dead socket
    // (100 to 250 ms), so binding again finds that worker, not yet ready.
    unlinkSync(SOCK);
    await staleSocket();
    const pending = checkDaemonLock();
    await sleep(40);
    unlinkSync(SOCK);
    const worker = await holder({ ready: false });
    await pending;
    expect(displaced).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
    await worker.stop();
    await checkDaemonLock();
    expect(await answersAs()).toBe(process.pid);
    expect(logs.splice(0)).toEqual([AGAIN]);
  });

  it("stops for a daemon that has taken its place and is ready, and leaves that one's files", async () => {
    unlinkSync(SOCK);
    const other = await holder({ ready: true });
    writeFileSync(PID_FILE, "4242\n");
    await checkDaemonLock();
    expect(displaced).toHaveBeenCalledTimes(1);
    expect(pidInFile()).toBe(4242);
    // What the worker's shutdown does last.
    releaseDaemonLock();
    expect(pidInFile()).toBe(4242);
    expect(await answersAs()).toBe(4242);
    await other.stop();
    // Let go: a check does nothing.
    await checkDaemonLock();
    expect(inode()).toBeNull();
    expect(pidInFile()).toBe(4242);
    expect(logs).toEqual([]);
    expect(stopped).not.toHaveBeenCalled();
  });
});
