/**
 * One capture daemon per user (engram#612).
 *
 * The worker listens on a local socket that only its user can reach:
 * ~/.engram/daemon.sock on macOS and Linux, a named pipe on Windows. A
 * worker that finds it answered exits at once, so a second start (launchd at
 * login beside `engram start`, or two starts at the same moment) can't put
 * two daemons on the same transcripts, each capturing and sending them.
 * "Running" means it answers, and the answer gives the worker's PID and
 * version.
 *
 * The PID file used to be the only record, and only a liveness test checked
 * it: a file left by a daemon that didn't exit cleanly could name a PID that
 * had since gone to another program, which `engram status` then reported as
 * the daemon and `engram stop` signalled.
 *
 * The socket is one-way. A client gets one line of JSON and the connection
 * ends; nothing a client sends is read, so nothing that reaches the socket
 * can make the daemon do anything. On Windows `engram stop` asks the daemon
 * to stop through a file in ~/.engram instead (STOP_FILE, engram#613),
 * which only the user can write.
 *
 * daemon.pid is still written, for CLIs from before this change, and is
 * trusted only for a process confirmed to be the daemon (identifyProcess).
 *
 * A daemon running as root in the user's ~/.engram is never the daemon
 * (engram#680): a worker started as root exits at once, and one already
 * running as root, which `sudo engram start` or `sudo engram install` left
 * before engram#653, keeps any other from starting while it runs.
 *
 * IMPORTANT: Node built-ins only. worker.ts claims the lock before the
 * native-module preflight, so nothing here may load better-sqlite3, directly
 * or through another module (see launch.ts).
 */

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, statSync, unlinkSync, type BigIntStats } from "node:fs";
import { createRequire } from "node:module";
import { connect, createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { rootForAnotherUser } from "./as-root.js";
import { ENGRAM_DIR, PID_FILE } from "./launch.js";
import { systemJob, type SystemJob } from "./launchd.js";
import { powerShellArgs, windowsPowerShellPath } from "./powershell.js";
import { ensurePrivateDirSync, readSmallFileSync, writePrivateFileSync } from "../private-files.js";

/** This package's version, which the daemon gives when it answers. */
export const VERSION: string = (() => {
  try {
    const pkg = createRequire(import.meta.url)("../../package.json") as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
})();

/** How long a probe waits for the daemon's answer. */
const PROBE_TIMEOUT_MS = 1_500;
/** An answer is one short line; a longer one isn't the daemon's. */
const MAX_ANSWER_BYTES = 1_024;
/** At most this many clients at once. Each is answered and let go at once. */
const MAX_CLIENTS = 16;
/** A client that doesn't take its answer is dropped after this long. */
const CLIENT_TIMEOUT_MS = 5_000;
/** Binding again after another start got in the way, at most this often. */
const LOCK_TRIES = 5;
/**
 * How long a start waits for a daemon that is stopping: its shutdown waits
 * up to 7 s for a send in progress and 7 s for the last one.
 */
export const STOPPING_WAIT_MS = 20_000;
const POLL_MS = 250;
/** How long a socket just bound is left before checking it is still this daemon's. */
const SETTLE_MS = 250;
/** How often the daemon checks that its socket and PID file are still there. */
const SELF_CHECK_MS = 30_000;
/** How often the daemon looks for a stop request (STOP_FILE). */
const STOP_POLL_MS = 1_000;
/** A stop request is a few dozen bytes: anything longer isn't one. */
const MAX_STOP_BYTES = 1_024;

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * lstat of the socket's path, with BigInt fields. Every plain stat in the
 * process leaves the type of what it found in one buffer Node keeps, and
 * fs.realpathSync, which loads modules, reads that buffer back: when it
 * says socket, a path being resolved stops at the first part already known
 * not to be a link, and that unresolved path is cached. The next package
 * loaded through a symlinked node_modules (as pnpm installs) can then not
 * find what it requires, and `engram status` couldn't open the local queue
 * while a daemon was running (engram#612). A BigInt stat leaves that buffer
 * as it was.
 */
function lstatSocketPath(path: string): BigIntStats {
  return lstatSync(path, { bigint: true });
}

function lstatOrNull(path: string): BigIntStats | null {
  try {
    return lstatSocketPath(path);
  } catch {
    return null;
  }
}

// ── Where the daemon listens ──

export interface Endpoint {
  /** The socket's path, or on Windows the pipe's name. */
  path: string;
  pipe: boolean;
}

export type EndpointOrReason = Endpoint | { unavailable: string };

/** The longest socket path each platform takes, in bytes: sun_path less its NUL. */
function maxSocketPath(platform: NodeJS.Platform): number {
  return platform === "linux" ? 107 : 103;
}

/**
 * ~/.engram/daemon.sock, or on Windows a named pipe. Pipe names are one
 * namespace for the whole machine, so the name carries a hash of this
 * user's ~/.engram.
 *
 * A socket path longer than the platform takes is cut short by Node 20 and
 * refused by later versions. A home folder that long gets no lock: the
 * daemon still runs, with the PID file as its only record (see
 * claimDaemonLock).
 */
export function daemonEndpoint(dir: string = ENGRAM_DIR, platform: NodeJS.Platform = process.platform): EndpointOrReason {
  if (platform === "win32") {
    const id = createHash("sha256").update(dir.toLowerCase()).digest("hex").slice(0, 32);
    return { path: `\\\\.\\pipe\\engram-daemon-${id}`, pipe: true };
  }
  const path = join(dir, "daemon.sock");
  const bytes = Buffer.byteLength(path);
  const max = maxSocketPath(platform);
  if (bytes > max) {
    return { unavailable: `the socket path would be ${bytes} bytes, and the most this system takes is ${max}` };
  }
  return { path, pipe: false };
}

function where(endpoint: Endpoint): string {
  return endpoint.pipe ? "the daemon's named pipe" : "~/.engram/daemon.sock";
}

// ── The answer ──

/** What the daemon says about itself. */
export interface DaemonInfo {
  pid: number;
  /** Its package version, when it gave a well-formed one. */
  version?: string;
  startedAt?: string;
  /** Which server answered: tells a daemon's own socket from one bound since. */
  id?: string;
  /** Its modules have loaded and capture is set up: `engram start` waits for this. */
  ready: boolean;
  /** It is shutting down: finishing a send, then exiting. */
  stopping: boolean;
  /** It stops when STOP_FILE asks it to (engram#613): on Windows, from this version on. */
  stopFile: boolean;
  /**
   * It reads the vault key again before sending (engram#693): a key saved
   * while it runs is used without a restart. One from before reads it only
   * at start.
   */
  vaultKeyReread: boolean;
  /**
   * It reads the vault again before its next send when `engram vault set`
   * or `engram vault delete` says the vault changed (engram#701). One from
   * before reads it every 10 minutes.
   */
  vaultChangeNotice: boolean;
  /**
   * Whether it has a vault key (engram#698). false: it has none, so only
   * the built-in patterns are removed from what it sends. true: it has one,
   * or holds sends for one it can't read. Undefined: one from before, or
   * one that hasn't read it yet.
   */
  vaultKey?: boolean;
}

const self = {
  ready: false,
  stopping: false,
  startedAt: new Date().toISOString(),
  vaultKey: undefined as boolean | undefined,
};

function answer(id: string): string {
  return `${JSON.stringify({
    engram: "daemon",
    protocol: 1,
    pid: process.pid,
    version: VERSION,
    started_at: self.startedAt,
    id,
    ready: self.ready,
    stopping: self.stopping,
    stop_file: watchStopFile,
    vault_key_reread: true,
    vault_change_notice: true,
    ...(self.vaultKey === undefined ? {} : { vault_key: self.vaultKey }),
  })}\n`;
}

/**
 * The daemon's answer, or null for anything else. What is printed from it
 * (the version) is checked character by character: whatever holds the
 * socket, a terminal never gets control characters from it.
 */
export function parseAnswer(line: string): DaemonInfo | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const a = value as Record<string, unknown>;
  if (a.engram !== "daemon") return null;
  if (typeof a.pid !== "number" || !Number.isSafeInteger(a.pid) || a.pid <= 0) return null;
  const text = (v: unknown, pattern: RegExp): string | undefined =>
    typeof v === "string" && pattern.test(v) ? v : undefined;
  return {
    pid: a.pid,
    version: text(a.version, /^[0-9A-Za-z.+-]{1,50}$/),
    startedAt: text(a.started_at, /^[0-9T:.Z-]{1,40}$/),
    id: text(a.id, /^[0-9a-f]{32}$/),
    ready: a.ready === true,
    stopping: a.stopping === true,
    stopFile: a.stop_file === true,
    vaultKeyReread: a.vault_key_reread === true,
    vaultChangeNotice: a.vault_change_notice === true,
    vaultKey: typeof a.vault_key === "boolean" ? a.vault_key : undefined,
  };
}

/** A server that answers each client with one line and lets it go. */
function answeringServer(id: string): Server {
  const server = createServer((socket) => {
    socket.on("error", () => {
      // the client went away; nothing to do
    });
    socket.setTimeout(CLIENT_TIMEOUT_MS, () => socket.destroy());
    socket.end(answer(id));
    // Whatever the client sends is drained and dropped, never parsed.
    socket.resume();
  });
  server.maxConnections = MAX_CLIENTS;
  return server;
}

/**
 * Listen on `endpoint`: null once listening, else the error. The socket
 * file takes its mode from the umask, so the umask is 077 for the bind,
 * which happens inside listen(), and put back right after.
 */
function listenOn(server: Server, endpoint: Endpoint, log: (msg: string) => void): Promise<NodeJS.ErrnoException | null> {
  return new Promise((resolve) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.off("listening", onListening);
      resolve(err);
    };
    const onListening = (): void => {
      server.off("error", onError);
      // From here on an error (accept failing for lack of file
      // descriptors) is logged: unhandled, it would end the daemon.
      server.on("error", (err) => log(`daemon socket: ${errorText(err)}`));
      resolve(null);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    let umask: number | null = null;
    if (!endpoint.pipe) {
      try {
        umask = process.umask(0o077);
      } catch {
        // not allowed in a worker thread; ~/.engram is 0700 regardless
      }
    }
    try {
      server.listen(endpoint.path);
    } catch (err) {
      onError(err as NodeJS.ErrnoException);
    } finally {
      if (umask !== null) process.umask(umask);
    }
  });
}

// ── Probing ──

export type Probe =
  | { state: "answered"; info: DaemonInfo }
  /**
   * Something holds the endpoint but didn't answer in time: a daemon whose
   * event loop is busy (the preflight's `npm rebuild` blocks it for a minute
   * or two), or something that isn't a daemon at all.
   */
  | { state: "silent" }
  /** Nothing listens. `stale`: a socket file is there, left by a daemon that didn't exit cleanly. */
  | { state: "none"; stale: boolean }
  /** Can't tell (reason): the endpoint can't be used here, or isn't the user's own. */
  | { state: "unavailable"; reason: string };

/** Before connecting: only a socket of the user's own is asked. */
function checkSocketFile(path: string): Probe | null {
  let st: BigIntStats;
  try {
    st = lstatSocketPath(path);
  } catch (err) {
    if (errCode(err) === "ENOENT") return { state: "none", stale: false };
    return { state: "unavailable", reason: `couldn't check ~/.engram/daemon.sock (${errCode(err) ?? errorText(err)})` };
  }
  if (!st.isSocket()) return { state: "unavailable", reason: "~/.engram/daemon.sock is there but isn't a socket" };
  const uid = process.geteuid?.();
  if (uid !== undefined && st.uid !== BigInt(uid)) {
    return { state: "unavailable", reason: "~/.engram/daemon.sock belongs to another user" };
  }
  return null;
}

/** Ask whatever listens on the daemon's endpoint who it is. Never throws. */
export function probeDaemon(options: { timeoutMs?: number; endpoint?: EndpointOrReason } = {}): Promise<Probe> {
  const endpoint = options.endpoint ?? daemonEndpoint();
  if ("unavailable" in endpoint) return Promise.resolve({ state: "unavailable", reason: endpoint.unavailable });
  if (!endpoint.pipe) {
    const checked = checkSocketFile(endpoint.path);
    if (checked) return Promise.resolve(checked);
  }
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    let received = Buffer.alloc(0);
    const socket = connect(endpoint.path);
    const finish = (probe: Probe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(probe);
    };
    const timer = setTimeout(() => finish({ state: "silent" }), timeoutMs);
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf(0x0a);
      if (end >= 0) {
        const info = parseAnswer(received.subarray(0, end).toString("utf-8"));
        finish(info ? { state: "answered", info } : { state: "silent" });
      } else if (received.length > MAX_ANSWER_BYTES) {
        finish({ state: "silent" });
      }
    });
    socket.on("close", () => finish({ state: "silent" }));
    socket.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNREFUSED") finish({ state: "none", stale: !endpoint.pipe });
      else if (err.code === "ENOENT") finish({ state: "none", stale: false });
      else finish({ state: "unavailable", reason: `couldn't reach ${where(endpoint)} (${err.code ?? err.message})` });
    });
  });
}

// ── Taking the endpoint ──

/** Who holds the endpoint, when it isn't this process. */
export type Taken =
  | { why: "socket"; info: DaemonInfo }
  | { why: "silent" }
  | { why: "stopping"; pid: number }
  | { why: "pidfile"; pid: number }
  | { why: "unknown"; tries: number };

export interface Held {
  server: Server;
  endpoint: Endpoint;
  /** What this server answers with, to tell its socket from one bound since. */
  id: string;
  /** The socket file's identity, on macOS and Linux (0n for a pipe). */
  dev: bigint;
  ino: bigint;
}

export type LockResult =
  | { state: "held"; held: Held }
  | { state: "taken"; taken: Taken }
  | { state: "unavailable"; reason: string };

export interface LockOptions {
  log?: (msg: string) => void;
  /** Tests shorten it. */
  settleMs?: number;
}

/**
 * Whether the socket file at the endpoint is the one `id`'s server is bound
 * to: it answers with that id, and the file is the same before and after
 * asking. Returns its dev and ino when it is.
 */
async function boundTo(endpoint: Endpoint, id: string): Promise<{ dev: bigint; ino: bigint } | null> {
  const before = lstatOrNull(endpoint.path);
  if (!before) return null;
  const probe = await probeDaemon({ endpoint });
  if (probe.state !== "answered" || probe.info.id !== id) return null;
  const after = lstatOrNull(endpoint.path);
  if (!after || after.dev !== before.dev || after.ino !== before.ino) return null;
  return { dev: before.dev, ino: before.ino };
}

/**
 * The daemon named in the PID file, when it is alive and confirmed to be
 * one (and isn't this process): the user's own, or, `root`, one running as
 * root (engram#680).
 */
export function daemonInPidFile(): { pid: number; root: boolean } | null {
  const pid = pidInFile();
  if (pid === null || pid === process.pid || !alive(pid)) return null;
  const what = identifyProcess(pid);
  return what === "daemon" || what === "root" ? { pid, root: what === "root" } : null;
}

/** The user's own daemon, named in the PID file and confirmed (see daemonInPidFile). */
export function confirmedDaemonInPidFile(): number | null {
  const found = daemonInPidFile();
  return found !== null && !found.root ? found.pid : null;
}

/**
 * A daemon running as root for this user (engram#680), which `sudo engram
 * start` or `sudo engram install` started before engram#653: `inFile`, the
 * one the PID file names, or, on macOS, the one `job` runs, the job such an
 * install loaded into launchd's system domain from the user's own plist. A
 * CLI from before this change removed the PID file of a daemon it couldn't
 * signal. Each is looked up unless the caller has, the job only when the
 * PID file names none. Null when none runs.
 */
export function rootDaemonPid(
  inFile: { pid: number; root: boolean } | null = daemonInPidFile(),
  job?: SystemJob | null,
): number | null {
  if (inFile?.root) return inFile.pid;
  const loaded = job === undefined ? systemJob() : job;
  if (loaded?.pid == null || loaded.pid === process.pid) return null;
  return identifyProcess(loaded.pid) === "root" ? loaded.pid : null;
}

/**
 * Remove a socket file nothing listens on, left by a daemon that didn't exit
 * cleanly (killed, or the machine lost power). It is checked again a moment
 * later, at a random delay, and removed only if it is still the same file
 * and still refuses connections: when two starts find the same stale file,
 * the slower must not remove the socket the faster has bound since. If it
 * does anyway, the faster finds out before it settles (see lockEndpoint).
 */
async function removeStaleSocket(endpoint: Endpoint, log: (msg: string) => void): Promise<void> {
  const before = lstatOrNull(endpoint.path);
  if (!before) return;
  await sleep(100 + Math.floor(Math.random() * 150));
  const again = await probeDaemon({ endpoint });
  if (again.state !== "none" || !again.stale) return;
  const after = lstatOrNull(endpoint.path);
  if (!after || after.dev !== before.dev || after.ino !== before.ino) return;
  try {
    unlinkSync(endpoint.path);
    log("removed a daemon.sock left by a daemon that didn't exit cleanly");
  } catch (err) {
    if (errCode(err) !== "ENOENT") log(`couldn't remove a daemon.sock left by an earlier daemon (${errCode(err) ?? errorText(err)})`);
  }
}

/** Wait while a daemon that is stopping still holds the endpoint, up to STOPPING_WAIT_MS. */
async function waitWhileStopping(endpoint: Endpoint): Promise<void> {
  const deadline = Date.now() + STOPPING_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const probe = await probeDaemon({ endpoint });
    if (probe.state !== "answered" || !probe.info.stopping) return;
  }
}

/**
 * Take the endpoint for this process, or find out who has it.
 *
 * Binding is the lock: two binds to one path can't both succeed, and a
 * second named pipe of the same name can't be made. A socket file left by a
 * daemon that died (it refuses connections) is removed and the bind tried
 * again. After binding, the socket must still answer as this server once a
 * stale-socket removal racing this one has had time to land.
 */
export async function lockEndpoint(endpoint: Endpoint, options: LockOptions = {}): Promise<LockResult> {
  const log = options.log ?? (() => {});
  const settleMs = options.settleMs ?? SETTLE_MS;
  if (!endpoint.pipe) {
    try {
      ensurePrivateDirSync(dirname(endpoint.path));
    } catch (err) {
      return { state: "unavailable", reason: `couldn't create ~/.engram (${errCode(err) ?? errorText(err)})` };
    }
  }
  let waitedForStop = false;
  for (let tries = 0; tries < LOCK_TRIES; tries++) {
    const id = randomBytes(16).toString("hex");
    const server = answeringServer(id);
    const err = await listenOn(server, endpoint, log);
    if (err === null) {
      if (endpoint.pipe) return { state: "held", held: { server, endpoint, id, dev: 0n, ino: 0n } };
      await sleep(settleMs);
      const bound = await boundTo(endpoint, id);
      if (bound) return { state: "held", held: { server, endpoint, id, ...bound } };
      // Another start removed this socket and bound its own. Never close
      // this server: on macOS and Linux that removes the file at the path,
      // by name, and the file there now is the other's.
      server.unref();
      continue;
    }
    // The path is taken. macOS says EEXIST, not EADDRINUSE, when another
    // start binds it at the same moment: bind looks the name up, then makes
    // it, and the other made it in between. Taken for a socket that can't be
    // used here, it left a daemon running without the lock (engram#708).
    if (err.code !== "EADDRINUSE" && err.code !== "EEXIST") {
      return { state: "unavailable", reason: `couldn't listen on ${where(endpoint)} (${err.code ?? err.message})` };
    }
    const probe = await probeDaemon({ endpoint });
    if (probe.state === "answered") {
      if (!probe.info.stopping) return { state: "taken", taken: { why: "socket", info: probe.info } };
      if (waitedForStop) return { state: "taken", taken: { why: "stopping", pid: probe.info.pid } };
      // `engram stop` and then `engram start`, or launchd starting one
      // while the last finishes: once it has gone, this one takes over.
      waitedForStop = true;
      await waitWhileStopping(endpoint);
      tries--;
      continue;
    }
    if (probe.state === "silent") return { state: "taken", taken: { why: "silent" } };
    if (probe.state === "unavailable") return { state: "unavailable", reason: probe.reason };
    if (probe.stale) {
      // A socket that refuses connections is normally a dead daemon's. But
      // macOS refuses them too while a live daemon's backlog is full, and a
      // daemon from before engram#612 has no socket at all: a confirmed
      // daemon in the PID file keeps the socket where it is.
      const pid = confirmedDaemonInPidFile();
      if (pid !== null) return { state: "taken", taken: { why: "pidfile", pid } };
      await removeStaleSocket(endpoint, log);
    } else if (endpoint.pipe) {
      // The pipe's name is taken, and nothing accepts on it: a daemon
      // letting it go. The name is free once its last connection closes.
      await sleep(POLL_MS);
    }
    // Gone since, or removed just now: bind again.
  }
  return { state: "taken", taken: { why: "unknown", tries: LOCK_TRIES } };
}

/**
 * Let the endpoint go. On macOS and Linux the socket file is removed only
 * while it is still this server's, and the server is never closed: closing
 * removes whatever file is at the path by then, by name. The process exits
 * right after, which ends the server without touching the path.
 */
export function unlockEndpoint(held: Held): void {
  if (held.endpoint.pipe) {
    held.server.close();
    return;
  }
  const st = lstatOrNull(held.endpoint.path);
  if (st && st.dev === held.dev && st.ino === held.ino) {
    try {
      unlinkSync(held.endpoint.path);
    } catch {
      // gone already
    }
  }
  held.server.unref();
}

// ── The PID file and processes ──

/**
 * The PID in daemon.pid: digits only, so "-1" or "0", which would signal
 * every process the user has or the whole process group, never come back.
 */
export function pidInFile(file: string = PID_FILE): number | null {
  let text: string;
  try {
    text = readFileSync(file, "utf-8").trim();
  } catch {
    return null;
  }
  if (!/^\d{1,10}$/.test(text)) return null;
  const pid = Number(text);
  return pid > 0 && pid <= 0x7fffffff ? pid : null;
}

/** Remove daemon.pid when it names `pid`, and only then. */
export function removePidFileIf(pid: number, file: string = PID_FILE): void {
  if (pidInFile(file) !== pid) return;
  try {
    unlinkSync(file);
  } catch {
    // gone already
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errCode(err) === "EPERM";
  }
}

/**
 * The worker's script, as an install runs it: dist/daemon/worker.js, or
 * worker-main.js from a plist before 0.4.2. A quote may end it: Windows
 * puts a path with a space in it in quotes on the command line.
 */
const WORKER_SCRIPT = /(?:^|[\s/\\])dist[\\/]daemon[\\/]worker(?:-main)?\.js(?:["\s]|$)/;

/**
 * What a process that runs `args` as the user `owner` is to the user `me`:
 * their daemon, a daemon running as root (engram#680), or something else.
 * Root's only for a user who isn't root. Pure: the tests pass made-up
 * processes.
 */
export function processKind(owner: number, args: string, me: number | undefined): "daemon" | "root" | "other" {
  if (!WORKER_SCRIPT.test(args.trim())) return "other";
  if (owner === me) return "daemon";
  return owner === 0 && me !== undefined && me !== 0 ? "root" : "other";
}

/**
 * Whether `pid` is this user's daemon: a process of the user's running the
 * worker's script. "root": the worker's script running as root, for a user
 * who isn't (engram#680), which the user can't signal. "unknown" when that
 * can't be found out (`ps` or PowerShell failed, or Windows won't say, as
 * for a process run as administrator), which is never taken for the
 * daemon. A daemon started with `engram start --foreground` runs the CLI's
 * script, and is found through its socket only.
 */
export function identifyProcess(pid: number): "daemon" | "root" | "other" | "unknown" {
  if (process.platform === "win32") return identifyOnWindows(pid);
  const uid = process.geteuid?.();
  if (process.platform === "linux") {
    try {
      const owner = statSync(`/proc/${pid}`).uid;
      const args = readFileSync(`/proc/${pid}/cmdline`, "utf-8").split("\0").join(" ");
      return processKind(owner, args, uid);
    } catch (err) {
      return errCode(err) === "ENOENT" ? "other" : "unknown";
    }
  }
  let out: string;
  try {
    out = execFileSync("/bin/ps", ["-ww", "-o", "uid=,args=", "-p", String(pid)], {
      encoding: "utf-8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    // ps exits 1 when there is no such process.
    return (err as { status?: unknown }).status === 1 ? "other" : "unknown";
  }
  const match = /^\s*(\d+)\s+(.*)$/.exec(out.split("\n")[0] ?? "");
  if (!match) return "other";
  return processKind(Number(match[1]), match[2], uid);
}

/**
 * Every process that runs the worker's script as root, when this user
 * isn't root (engram#680), whatever started it: on macOS, `ps`; on Linux,
 * /proc. None on Windows, or when they can't be listed. Only ever said, in
 * `engram status` and `engram start`: nothing ties one of these to this
 * user, as the PID file or launchd's system domain does.
 */
export function rootWorkerPids(): number[] {
  const me = process.geteuid?.();
  if (me === undefined || me === 0) return [];
  const found: number[] = [];
  const take = (pid: number, owner: number, args: string): void => {
    if (pid !== process.pid && processKind(owner, args, me) === "root") found.push(pid);
  };
  if (process.platform === "linux") {
    let entries: string[];
    try {
      entries = readdirSync("/proc");
    } catch {
      return [];
    }
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const owner = statSync(`/proc/${entry}`).uid;
        if (owner !== 0) continue;
        take(Number(entry), owner, readFileSync(`/proc/${entry}/cmdline`, "utf-8").split("\0").join(" "));
      } catch {
        // gone since, or hidden
      }
    }
    return found;
  }
  if (process.platform !== "darwin") return [];
  let out: unknown;
  try {
    out = execFileSync("/bin/ps", ["-A", "-ww", "-o", "pid=,uid=,args="], {
      encoding: "utf-8",
      timeout: 5_000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  if (typeof out !== "string") return [];
  for (const line of out.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) take(Number(match[1]), Number(match[2]), match[3]);
  }
  return found;
}

// ── Identifying a process on Windows (engram#640) ──

/**
 * PowerShell's start and its two process queries take a second or two; this
 * leaves room for a busy machine. Past it, "unknown".
 */
const IDENTIFY_TIMEOUT_MS = 10_000;

/**
 * What identifies a process on Windows, one PowerShell statement each: its
 * owner, the owner of this PowerShell, which runs as the user, and its
 * command line, as one line of JSON; or "none" when there is no such
 * process. The PID comes in ENGRAM_IDENTIFY_PID, never in the script.
 *
 * The command line comes as its character codes, joined by commas.
 * PowerShell writes to a pipe in the console's code page, which turns what
 * it can't show into something else: on a Japanese system, the second byte
 * of a character can be a backslash, and Windows' "best fit" turns a
 * full-width quote into a plain one. Either would break the JSON, or change
 * what it says. Character codes are plain ASCII, whatever the code page.
 *
 * Cmdlets, operators and casts to plain types only, no .NET calls, so it
 * runs the same where PowerShell is locked down to Constrained Language
 * (AppLocker, WDAC).
 */
export const IDENTIFY_STATEMENTS: readonly string[] = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "$target = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + [int]$env:ENGRAM_IDENTIFY_PID)",
  "if ($null -eq $target) { 'none'; exit 0 }",
  "$self = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + $PID)",
  "$owner = Invoke-CimMethod -InputObject $target -MethodName GetOwnerSid",
  "$me = Invoke-CimMethod -InputObject $self -MethodName GetOwnerSid",
  "$command = $target.CommandLine",
  "if ($null -ne $command) { $command = [int[]][char[]]$command -join ',' }",
  "ConvertTo-Json -Compress -InputObject @{ owner = $owner.Sid; me = $me.Sid; command = $command }",
];

/** How to run IDENTIFY_STATEMENTS for `pid`. */
export function windowsIdentifyCommand(
  pid: number,
  systemRoot?: string,
): { file: string; args: string[]; env: Record<string, string> } {
  return {
    file: windowsPowerShellPath(systemRoot),
    args: powerShellArgs(IDENTIFY_STATEMENTS),
    env: { ENGRAM_IDENTIFY_PID: String(pid) },
  };
}

function identifyOnWindows(pid: number): "daemon" | "other" | "unknown" {
  const { file, args, env } = windowsIdentifyCommand(pid);
  let out: string;
  try {
    out = execFileSync(file, args, {
      encoding: "utf-8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: IDENTIFY_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch {
    // No PowerShell, an error in it, or too slow.
    return "unknown";
  }
  return windowsIdentity(out);
}

const SID = /^S-1(?:-\d+)+$/i;

/** A command line as IDENTIFY_STATEMENTS gives it, or null for anything else. */
function fromCharCodes(codes: string): string | null {
  if (!/^(?:\d{1,5}(?:,\d{1,5})*)?$/.test(codes)) return null;
  let text = "";
  for (const code of codes.match(/\d+/g) ?? []) {
    const unit = Number(code);
    if (unit > 0xffff) return null;
    text += String.fromCharCode(unit);
  }
  return text;
}

/**
 * What IDENTIFY_STATEMENTS printed, read: "other" for no such process, or
 * another user's; "daemon" for one of the user's running the worker's
 * script; "unknown" when it says too little, as for a process run as
 * administrator, whose owner or command line Windows doesn't give a process
 * that isn't.
 */
export function windowsIdentity(out: string): "daemon" | "other" | "unknown" {
  // The last line: anything PowerShell warns of comes before it. Trimming
  // drops a byte-order mark as well.
  const lines = out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1];
  if (last === undefined) return "unknown";
  if (last === "none") return "other";
  let found: unknown;
  try {
    found = JSON.parse(last);
  } catch {
    return "unknown";
  }
  if (typeof found !== "object" || found === null) return "unknown";
  const { owner, me, command } = found as Record<string, unknown>;
  if (typeof owner !== "string" || typeof me !== "string" || !SID.test(owner) || !SID.test(me)) return "unknown";
  if (owner.toUpperCase() !== me.toUpperCase()) return "other";
  // No command line: Windows didn't give it, as for a process run as administrator.
  const line = typeof command === "string" ? fromCharCodes(command) : null;
  if (line === null) return "unknown";
  return WORKER_SCRIPT.test(line) ? "daemon" : "other";
}

// ── Stopping on Windows ──

/**
 * Where `engram stop` asks the daemon to stop on Windows (engram#613).
 * There, process.kill is TerminateProcess: the daemon used to be ended
 * wherever it was, in the middle of a send or of writing its queue. The
 * socket stays one-way, so the request is a file in ~/.engram, which only
 * the user can write: `{"pid": …, "id": …}`, the PID and the id the
 * daemon's answer gave. The daemon looks for it every STOP_POLL_MS and
 * stops as it does for SIGTERM. A daemon the request doesn't name, by both,
 * leaves it alone: a file left from an earlier daemon can name a PID that
 * Windows has given to this one since, but never its id.
 *
 * The supervisor that starts the daemon again after a crash reads it too:
 * a daemon that exits with an error after a request was written was
 * stopped, and isn't started again (see supervise.ts).
 */
export const STOP_FILE = join(ENGRAM_DIR, "daemon.stop");

export interface StopRequest {
  /** The daemon it is for: null when it names none, as from an `engram stop` that found none running. */
  pid: number | null;
  id: string | null;
  /** Which write of the file this is. Every write is a new file (see writePrivateFileSync), so it differs from the last. */
  stamp: string;
}

/**
 * The stop request in STOP_FILE, or null when there is none. It must be a
 * small regular file, read without waiting (see readSmallFileSync): a FIFO
 * put there would otherwise hang the daemon on the read.
 */
export function readStopFile(file: string = STOP_FILE): StopRequest | null {
  const found = readSmallFileSync(file, MAX_STOP_BYTES);
  if (found === null) return null;
  let value: unknown = null;
  try {
    value = JSON.parse(found.data.toString("utf-8"));
  } catch {
    // not a request this version wrote: it still counts as one, for no daemon
  }
  const r = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return {
    pid: typeof r.pid === "number" && Number.isSafeInteger(r.pid) && r.pid > 0 ? r.pid : null,
    id: typeof r.id === "string" && /^[0-9a-f]{32}$/.test(r.id) ? r.id : null,
    stamp: found.stamp,
  };
}

/** Remove STOP_FILE when the request in it is one `matches` takes. */
export function removeStopFileIf(matches: (request: StopRequest) => boolean, file: string = STOP_FILE): void {
  const request = readStopFile(file);
  if (request === null || !matches(request)) return;
  try {
    unlinkSync(file);
  } catch {
    // gone already
  }
}

// ── The daemon's claim ──

export type Claim =
  /** This process is the daemon. */
  | { state: "held" }
  /** Another daemon runs (message), and this one should exit. `retry`: exit as failed, so launchd tries again. */
  | { state: "taken"; message: string; retry: boolean }
  /** No lock can be had here (reason): the daemon runs without one, as before engram#612. */
  | { state: "unavailable"; reason: string }
  /**
   * Asked to stop (SIGTERM, SIGINT, SIGHUP) before the lock was decided: it
   * has let go of what it held, and should exit 0 (engram#669).
   */
  | { state: "stopped" }
  /**
   * Running as root for another user (engram#680): never the daemon. It
   * took nothing, and should exit 0, so launchd doesn't start it again.
   */
  | { state: "refused"; message: string };

let log: (msg: string) => void = () => {};
let claim: Promise<Claim> | null = null;
let held: Held | null = null;
let released = false;
let checkTimer: NodeJS.Timeout | null = null;
let checking = false;
let warnedSocket = false;
/** Whether this daemon looks for stop requests: set when it claims the lock. */
let watchStopFile = false;
let stopTimer: NodeJS.Timeout | null = null;
/** The stamp of the last stop request looked at, so each is read once. */
let stopSeen: string | null = null;

let stopHandler: () => void = () => {
  releaseDaemonLock();
  process.exit(0);
};

let displacedHandler: () => void = () => {
  log("another daemon has taken over; this one is stopping");
  releaseDaemonLock();
  process.exit(0);
};

/**
 * What SIGTERM, SIGINT and SIGHUP do (and SIGBREAK, and a stop request, on
 * Windows): the worker sets its shutdown here once it has one.
 */
export function setStopHandler(fn: () => void): void {
  stopHandler = fn;
}

/** What happens when another daemon has taken the socket over. */
export function setDisplacedHandler(fn: () => void): void {
  displacedHandler = fn;
}

/** Answer as ready: modules loaded, capture set up. `engram start` waits for this (waitForWorker). */
export function markReady(): void {
  self.ready = true;
}

/** Answer as stopping, so a start waits for this one to finish. */
export function markStopping(): void {
  self.stopping = true;
}

/**
 * Answer whether it has a vault key (engram#698), once it has read it: see
 * DaemonInfo.vaultKey. It never goes back to none: a key read before is
 * used until a restart, and one that can't be read holds sends.
 */
export function markVaultKey(has: boolean): void {
  self.vaultKey = has;
}

function takenMessage(taken: Taken, endpoint: Endpoint): string {
  switch (taken.why) {
    case "socket": {
      const version = taken.info.version ? `, version ${taken.info.version}` : "";
      return `another daemon is already running (pid ${taken.info.pid}${version}); this one is exiting`;
    }
    case "silent":
      return `another daemon holds ${where(endpoint)} but isn't answering (busy, or still starting); this one is exiting`;
    case "stopping":
      return `a daemon that is stopping (pid ${taken.pid}) still holds ${where(endpoint)}; this one is exiting`;
    case "pidfile":
      return `another daemon is already running (pid ${taken.pid}); this one is exiting`;
    case "unknown":
      return `couldn't take ${where(endpoint)} after ${taken.tries} tries; this one is exiting`;
  }
}

function writePidFile(): void {
  try {
    ensurePrivateDirSync(ENGRAM_DIR);
    writePrivateFileSync(PID_FILE, String(process.pid), { durable: false });
  } catch (err) {
    log(`couldn't write ~/.engram/daemon.pid (${errCode(err) ?? errorText(err)})`);
  }
}

/**
 * Every SELF_CHECK_MS: the socket is still this daemon's, and the PID file
 * still names it. A socket removed from under it (a cleanup of ~/.engram)
 * is bound again. One another daemon has bound in its place, and that
 * answers as ready, means that daemon has taken over, and this one stops.
 * Exported for the tests.
 */
export async function checkDaemonLock(): Promise<void> {
  if (checking || released || self.stopping) return;
  checking = true;
  try {
    const h = held;
    if (h && !h.endpoint.pipe) {
      const st = lstatOrNull(h.endpoint.path);
      if (!st || st.dev !== h.dev || st.ino !== h.ino) {
        const probe = await probeDaemon({ endpoint: h.endpoint });
        if (probe.state === "answered" && probe.info.id !== h.id) {
          // Only to a daemon that is ready. A worker starting while the
          // socket was missing holds it for a moment, then finds this one
          // in the PID file and exits: had this one stopped for it, none
          // would be left. A daemon that has really taken over is ready
          // within seconds, and found so at a later check.
          if (probe.info.ready && !probe.info.stopping) displacedHandler();
          return;
        }
        if (probe.state === "none") await bindAgain(h);
        else if (!warnedSocket) {
          warnedSocket = true;
          log("~/.engram/daemon.sock was replaced by something that isn't this daemon");
        }
      }
    }
    if (!released && !self.stopping && pidInFile() !== process.pid) writePidFile();
  } finally {
    checking = false;
  }
}

async function bindAgain(old: Held): Promise<void> {
  if (lstatOrNull(old.endpoint.path)) await removeStaleSocket(old.endpoint, log);
  const result = await lockEndpoint(old.endpoint, { log });
  if (result.state === "held") {
    // The old server stays open, unreachable, until exit: closing it would
    // remove the new socket file by name.
    old.server.unref();
    held = result.held;
    log("~/.engram/daemon.sock was removed; listening on it again");
  } else if (result.state === "taken" && result.taken.why === "socket") {
    // Bound by another daemon since: it has taken over once it is ready
    // (see checkDaemonLock), and until then this one goes on.
    if (result.taken.info.ready) displacedHandler();
  } else if (!warnedSocket) {
    warnedSocket = true;
    log(`couldn't listen on ~/.engram/daemon.sock again (${result.state === "unavailable" ? result.reason : result.taken.why})`);
  }
}

/**
 * Stop when STOP_FILE asks this daemon to, by its PID and its id. Every
 * STOP_POLL_MS while it holds the lock, on Windows. Exported for the tests.
 */
export function checkStopRequest(): void {
  if (released || self.stopping || held === null) return;
  const request = readStopFile();
  if (request === null || request.stamp === stopSeen) return;
  stopSeen = request.stamp;
  if (request.pid !== process.pid || request.id !== held.id) return;
  log("stop requested ('engram stop')");
  stopHandler();
}

/**
 * Become the daemon, or find that one already runs: worker.ts calls this
 * before the preflight, so two starts never run `npm rebuild` at once, and
 * worker-main.ts again for a plist from before 0.4.2 that starts it
 * directly (engram#469). Only the first call does anything. Logs what it
 * found; the caller exits on "taken".
 *
 * Held, the PID file is written, SIGTERM, SIGINT and SIGHUP stop the
 * daemon through setStopHandler, and any exit releases both. On Windows a
 * stop request does too (STOP_FILE), and so does SIGBREAK. One of those
 * signals that comes before the lock is decided stops it once it is: the
 * claim is then "stopped" (engram#669).
 */
export function claimDaemonLock(options: ClaimOptions): Promise<Claim> {
  claim ??= claimOnce(options);
  return claim;
}

export interface ClaimOptions {
  log: (msg: string) => void;
  endpoint?: EndpointOrReason;
  settleMs?: number;
  /** Look for stop requests in STOP_FILE: on Windows unless set. The tests set it elsewhere. */
  stopFile?: boolean;
}

async function claimOnce(options: ClaimOptions): Promise<Claim> {
  log = options.log;
  // Root, running the daemon for the user (engram#680): `sudo engram start`
  // with a CLI from before engram#653, or a job such a CLI loaded into
  // launchd's system domain, started again. As root it would make files in
  // the user's ~/.engram that their own daemon can't write, and the user
  // couldn't stop it. It takes nothing: no socket, no PID file.
  if (rootForAnotherUser()) {
    const message =
      "daemon exiting: it runs as root, and Engram's daemon runs as you. Run 'engram start' as yourself, without sudo";
    log(message);
    return { state: "refused", message };
  }
  // Before the socket answers: the answer says whether it does.
  watchStopFile = options.stopFile ?? process.platform === "win32";
  // Before the socket answers, too: `engram stop` finds the daemon by it,
  // and it answers from the moment it is bound, a while before the lock is
  // decided (SETTLE_MS). A signal with no handler ends the process by that
  // signal, which launchd takes for a crash: it starts the daemon again ten
  // seconds later (engram#669). One that comes before the lock is decided
  // is acted on once it is.
  let deciding = true;
  let stopAsked = false;
  const onStop = (): void => {
    if (deciding) stopAsked = true;
    else stopHandler();
  };
  process.on("SIGTERM", onStop);
  process.on("SIGINT", onStop);
  // The terminal or console a daemon runs in the foreground in was closed.
  // Windows ends the process about ten seconds later.
  process.on("SIGHUP", onStop);
  // Ctrl-Break, in a console on Windows.
  if (process.platform === "win32") process.on("SIGBREAK", onStop);
  const endpoint = options.endpoint ?? daemonEndpoint();
  const result: LockResult =
    "unavailable" in endpoint
      ? { state: "unavailable", reason: endpoint.unavailable }
      : await lockEndpoint(endpoint, { log, settleMs: options.settleMs });
  // Nothing from here on waits, so no signal comes in before the return.
  deciding = false;

  if (result.state === "taken") {
    const message = takenMessage(result.taken, endpoint as Endpoint);
    log(message);
    return { state: "taken", message, retry: result.taken.why === "unknown" };
  }

  // A daemon from before engram#612 has no socket: its PID file, confirmed,
  // is the only sign of it.
  const inFile = daemonInPidFile();
  if (inFile !== null && !inFile.root) {
    if (result.state === "held") unlockEndpoint(result.held);
    const message =
      result.state === "held"
        ? `an older daemon is already running (pid ${inFile.pid}); this one is exiting. Run 'engram stop' and then 'engram start' to update it`
        : `another daemon is already running (pid ${inFile.pid}); this one is exiting`;
    log(message);
    return { state: "taken", message, retry: false };
  }

  // Nor has one running as root (engram#680), which the user can't stop:
  // two daemons would capture the same transcripts.
  const root = rootDaemonPid(inFile);
  if (root !== null) {
    if (result.state === "held") unlockEndpoint(result.held);
    const message = `a daemon started with sudo is still running as root (pid ${root}); this one is exiting. Run 'engram status' to see how to stop it`;
    log(message);
    return { state: "taken", message, retry: false };
  }

  if (stopAsked) {
    // Never the daemon: its own socket goes, and no PID file was written.
    if (result.state === "held") unlockEndpoint(result.held);
    log("asked to stop while starting; this one is exiting");
    return { state: "stopped" };
  }

  if (result.state === "held") held = result.held;
  else log(`running without the single-daemon lock: ${result.reason}`);
  writePidFile();
  process.on("exit", releaseDaemonLock);
  checkTimer = setInterval(() => void checkDaemonLock(), SELF_CHECK_MS);
  checkTimer.unref();
  if (result.state === "held" && watchStopFile) {
    stopTimer = setInterval(checkStopRequest, STOP_POLL_MS);
    stopTimer.unref();
    // A request this daemon stopped for is removed once it has, cleanly.
    // After an error exit it stays, for the supervisor: that exit came
    // after `engram stop`, so the daemon isn't started again.
    process.on("exit", (code) => {
      if (code === 0) removeStopFileIf((request) => request.pid === process.pid);
    });
  } else {
    watchStopFile = false;
  }
  return result.state === "held" ? { state: "held" } : { state: "unavailable", reason: result.reason };
}

/**
 * Let the lock go: the PID file first, when it names this process, so a
 * start that finds the socket gone doesn't then find this process, alive
 * for a moment more, named as the daemon. Then the socket. Safe to call
 * more than once, and on every exit.
 */
export function releaseDaemonLock(): void {
  if (released) return;
  released = true;
  if (checkTimer) clearInterval(checkTimer);
  if (stopTimer) clearInterval(stopTimer);
  if (claim === null) return;
  removePidFileIf(process.pid);
  if (held) unlockEndpoint(held);
  held = null;
}
