import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Endpoint, Held, LockOptions, LockResult } from "../daemon/instance.js";
import { writePrivateFileSync } from "../private-files.js";

/**
 * engram#612 — one daemon per user, found by what answers on its socket
 * (~/.engram/daemon.sock) or, on Windows, its named pipe. These bind real
 * sockets and pipes in a temp home: nothing reaches the real ~/.engram, and
 * no running daemon is asked or signalled.
 *
 * claimDaemonLock is never called here: it writes the PID file and sets
 * SIGTERM, SIGINT and exit handlers on the process it runs in. The only
 * processes signalled are the ones these tests start.
 */

const { home } = vi.hoisted(() => ({ home: { dir: "" } }));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));

const POSIX = process.platform !== "win32";

/** A socket path can be 103 bytes at most on macOS: a long TMPDIR won't do. */
function shortTempBase(): string {
  const base = tmpdir();
  return !POSIX || Buffer.byteLength(base) <= 60 ? base : "/tmp";
}

home.dir = mkdtempSync(join(shortTempBase(), "e612-"));
const ENGRAM_DIR = join(home.dir, ".engram");
const PID_FILE = join(ENGRAM_DIR, "daemon.pid");
mkdirSync(ENGRAM_DIR, { recursive: true });

const {
  IDENTIFY_STATEMENTS,
  VERSION,
  alive,
  confirmedDaemonInPidFile,
  daemonEndpoint,
  identifyProcess,
  lockEndpoint,
  markReady,
  markStopping,
  parseAnswer,
  pidInFile,
  probeDaemon,
  readStopFile,
  removePidFileIf,
  removeStopFileIf,
  unlockEndpoint,
  windowsIdentifyCommand,
  windowsIdentity,
} = await import("../daemon/instance.js");

/** No process has this PID: Linux tops out at 2^22, macOS at 99999. */
const NO_SUCH_PID = 2_147_483_646;

let dir = "";
const holders: Array<{ stop: () => Promise<void> }> = [];
const lockServers: Server[] = [];
const children: ChildProcess[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(home.dir, "t"));
  rmSync(PID_FILE, { force: true });
});

afterEach(async () => {
  // Closing a server removes the socket file at its path, by name: each
  // test has its own folder, so only that test's files go.
  for (const h of holders.splice(0)) await h.stop();
  for (const server of lockServers.splice(0)) server.close();
  for (const child of children.splice(0)) await killed(child);
  rmSync(PID_FILE, { force: true });
});

afterAll(() => {
  rmSync(home.dir, { recursive: true, force: true });
});

/** The endpoint for a ~/.engram at `at`: a socket in it, or a pipe named for it. */
function endpointIn(at: string): Endpoint {
  const endpoint = daemonEndpoint(at);
  if ("unavailable" in endpoint) throw new Error(`the test's socket path is too long: ${endpoint.unavailable}`);
  return endpoint;
}

/** lockEndpoint, with the server it holds closed after the test. */
async function lock(endpoint: Endpoint, options: LockOptions = {}): Promise<LockResult> {
  const result = await lockEndpoint(endpoint, { settleMs: 20, ...options });
  if (result.state === "held") lockServers.push(result.held.server);
  return result;
}

function heldOf(result: LockResult): Held {
  if (result.state !== "held") throw new Error(`expected the lock, got ${JSON.stringify(result)}`);
  return result.held;
}

/** A line the way a daemon answers, from a made-up daemon. */
function answerLine(fields: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
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
}

/**
 * Something else listening at the endpoint: it answers every client with
 * `reply` and ends the connection, or with null holds it and says nothing.
 */
async function holder(endpoint: Endpoint, reply: string | Buffer | null): Promise<{ stop: () => Promise<void> }> {
  const open = new Set<Socket>();
  const server = createServer((socket) => {
    socket.on("error", () => {});
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    if (reply !== null) socket.end(reply);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint.path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  let stopped: Promise<void> | null = null;
  const h = {
    stop: () => {
      stopped ??= new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        server.close(() => resolve());
      });
      return stopped;
    },
  };
  holders.push(h);
  return h;
}

/**
 * A socket file nothing listens on, as a daemon that was killed leaves it.
 * Closing a server removes its socket file, so the file is moved aside
 * while it closes and put back after.
 */
async function staleSocket(path: string): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  renameSync(path, `${path}.aside`);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  renameSync(`${path}.aside`, path);
}

/** A node process of this test's that waits; `args` are what `ps` shows after the script. */
async function sleeper(...args: string[]): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ...args], { stdio: "ignore" });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
  if (child.pid === undefined) throw new Error("the test's process has no PID");
  return child.pid;
}

function killed(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  });
}

function isSocket(path: string): boolean {
  try {
    return lstatSync(path).isSocket();
  } catch {
    return false;
  }
}

async function until(test: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!test()) {
    if (Date.now() > deadline) throw new Error("gave up waiting");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/**
 * A package in `at`/store, linked from `at`/app/node_modules the way pnpm
 * installs one. Returns where its main file really is.
 */
function linkedPackage(at: string, name: string): string {
  const pkg = join(at, "store", name);
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name, main: "index.js" }));
  writeFileSync(join(pkg, "index.js"), "module.exports = {};\n");
  mkdirSync(join(at, "app", "node_modules"), { recursive: true });
  symlinkSync(pkg, join(at, "app", "node_modules", name), "dir");
  return realpathSync.native(join(pkg, "index.js"));
}

/** Everything a client gets from the endpoint, sending `send` first. */
function exchange(endpoint: Endpoint, send?: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect(endpoint.path);
    socket.on("connect", () => {
      if (send) socket.write(send, () => {});
    });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", (err: NodeJS.ErrnoException) => {
      // The daemon may let go before it has drained what was sent.
      if (err.code === "ECONNRESET" || err.code === "EPIPE") resolve(Buffer.concat(chunks).toString("utf-8"));
      else reject(err);
    });
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}

describe("where the daemon listens", () => {
  it("is ~/.engram/daemon.sock on macOS and Linux", () => {
    const at = join("/home", "ana", ".engram");
    for (const platform of ["darwin", "linux"] as const) {
      expect(daemonEndpoint(at, platform)).toEqual({ path: join(at, "daemon.sock"), pipe: false });
    }
  });

  it("takes a socket path as long as the system does, and no longer", () => {
    // "/", the folder, "/daemon.sock": 13 bytes besides the folder's name.
    const at = (bytes: number): string => `/${"a".repeat(bytes - 13)}`;
    expect(daemonEndpoint(at(103), "darwin")).toMatchObject({ pipe: false });
    expect(daemonEndpoint(at(104), "darwin")).toEqual({
      unavailable: "the socket path would be 104 bytes, and the most this system takes is 103",
    });
    expect(daemonEndpoint(at(107), "linux")).toMatchObject({ pipe: false });
    expect(daemonEndpoint(at(108), "linux")).toEqual({
      unavailable: "the socket path would be 108 bytes, and the most this system takes is 107",
    });
    // Bytes, not characters: 59 characters, 105 bytes.
    expect(daemonEndpoint(`/${"é".repeat(46)}`, "darwin")).toEqual({
      unavailable: "the socket path would be 105 bytes, and the most this system takes is 103",
    });
  });

  it("is a named pipe on Windows, one per user's folder whatever its case", () => {
    const ana = daemonEndpoint("C:\\Users\\Ana\\.engram", "win32");
    expect(ana).toEqual({ path: expect.stringMatching(/^\\\\\.\\pipe\\engram-daemon-[0-9a-f]{32}$/), pipe: true });
    expect(daemonEndpoint("c:\\users\\ana\\.engram", "win32")).toEqual(ana);
    expect(daemonEndpoint("C:\\Users\\Bob\\.engram", "win32")).not.toEqual(ana);
  });
});

describe("reading the daemon's answer", () => {
  it("reads what a daemon says about itself", () => {
    expect(parseAnswer(answerLine().trim())).toEqual({
      pid: 4242,
      version: "0.7.0",
      startedAt: "2026-11-09T10:00:00.000Z",
      id: "0".repeat(32),
      ready: true,
      stopping: false,
      stopFile: false,
    });
  });

  it("reads whether it takes a request to stop from the stop file (engram#613)", () => {
    expect(parseAnswer(answerLine({ stop_file: true }).trim())?.stopFile).toBe(true);
    // A daemon from before then says nothing of it; only true is taken for yes.
    for (const value of [false, "true", 1, null]) {
      expect(parseAnswer(answerLine({ stop_file: value }).trim())?.stopFile, String(value)).toBe(false);
    }
  });

  it("takes nothing else for a daemon", () => {
    for (const line of [
      "",
      "hello",
      "null",
      "[]",
      "42",
      JSON.stringify({ pid: 4242 }),
      answerLine({ engram: "something else" }),
      answerLine({ pid: 0 }),
      answerLine({ pid: -1 }),
      answerLine({ pid: 1.5 }),
      answerLine({ pid: "4242" }),
      answerLine({ pid: 2 ** 53 }),
      answerLine({ pid: null }),
    ]) {
      expect(parseAnswer(line.trim()), line).toBeNull();
    }
  });

  it("drops text that isn't plain, so a terminal never prints control characters from it", () => {
    const info = parseAnswer(
      answerLine({ version: "0.7.0\u001b[2J", started_at: "yesterday\n", id: "not-an-id" }).trim(),
    );
    expect(info).toMatchObject({ pid: 4242 });
    expect(info?.version).toBeUndefined();
    expect(info?.startedAt).toBeUndefined();
    expect(info?.id).toBeUndefined();
    expect(parseAnswer(answerLine({ version: "9".repeat(51) }).trim())?.version).toBeUndefined();
  });

  it("counts ready and stopping only when they are true", () => {
    for (const value of ["true", 1, "yes", null, {}]) {
      expect(parseAnswer(answerLine({ ready: value, stopping: value }).trim())).toMatchObject({
        ready: false,
        stopping: false,
      });
    }
    expect(parseAnswer(answerLine({ ready: false, stopping: true }).trim())).toMatchObject({
      ready: false,
      stopping: true,
    });
  });
});

describe("the stop file (engram#613)", () => {
  const ID = "c".repeat(32);
  const STAMP = /^\d+:\d+:\d+:\d+$/;

  it("reads a request: the PID and the id of the daemon it is for", () => {
    const file = join(dir, "daemon.stop");
    writePrivateFileSync(file, `${JSON.stringify({ pid: 4242, id: ID })}\n`);
    expect(readStopFile(file)).toEqual({ pid: 4242, id: ID, stamp: expect.stringMatching(STAMP) });
    // From an `engram stop` that found no daemon running: for a supervisor
    // waiting to start one again, and for no daemon.
    writePrivateFileSync(file, `${JSON.stringify({ pid: null })}\n`);
    expect(readStopFile(file)).toEqual({ pid: null, id: null, stamp: expect.stringMatching(STAMP) });
  });

  it("takes anything else written there for a request for no daemon", () => {
    const file = join(dir, "daemon.stop");
    for (const text of [
      "",
      "not json",
      "null",
      "[]",
      JSON.stringify({ pid: "4242", id: ID }),
      JSON.stringify({ pid: 0, id: ID }),
      JSON.stringify({ pid: -1, id: ID }),
      JSON.stringify({ pid: 1.5, id: ID }),
      JSON.stringify({ pid: 2 ** 53, id: ID }),
    ]) {
      writePrivateFileSync(file, text);
      expect(readStopFile(file), text).toMatchObject({ pid: null });
    }
    for (const id of ["C".repeat(32), "c".repeat(31), "c".repeat(33), `${"c".repeat(31)}g`, 42, null]) {
      writePrivateFileSync(file, JSON.stringify({ pid: 4242, id }));
      expect(readStopFile(file), String(id)).toMatchObject({ pid: 4242, id: null });
    }
  });

  it("tells each request from the last by its stamp", () => {
    const file = join(dir, "daemon.stop");
    const request = JSON.stringify({ pid: 4242, id: ID });
    writePrivateFileSync(file, request);
    const first = readStopFile(file)?.stamp;
    expect(readStopFile(file)?.stamp).toBe(first);
    // The same request again: `engram stop` run twice.
    writePrivateFileSync(file, request);
    expect(readStopFile(file)?.stamp).not.toBe(first);
  });

  it("is no request when there is none, or when it isn't a small regular file", () => {
    const file = join(dir, "daemon.stop");
    expect(readStopFile(file)).toBeNull();
    mkdirSync(file);
    expect(readStopFile(file)).toBeNull();
    rmSync(file, { recursive: true });
    writeFileSync(file, JSON.stringify({ pid: 4242, id: ID, pad: "x".repeat(1_100) }));
    expect(readStopFile(file)).toBeNull();
  });

  it.skipIf(!POSIX)("doesn't wait on a FIFO put in its place", () => {
    // Read without O_NONBLOCK, a FIFO would stop the daemon's event loop
    // until something wrote to it. A writer comes along after a second here,
    // so that such a read fails the timing below rather than hanging the run.
    const file = join(dir, "daemon.stop");
    execFileSync("mkfifo", [file]);
    children.push(spawn("/bin/sh", ["-c", 'sleep 1; echo x > "$0"', file], { stdio: "ignore" }));
    const before = Date.now();
    expect(readStopFile(file)).toBeNull();
    expect(Date.now() - before).toBeLessThan(500);
  });

  it.skipIf(!POSIX)("is no request when a link in its place leads to a device", () => {
    // /dev/null reads as empty: a regular file that did would be a request
    // for no daemon.
    const file = join(dir, "daemon.stop");
    symlinkSync("/dev/null", file);
    expect(readStopFile(file)).toBeNull();
  });

  it("is removed only when it holds the request asked for", () => {
    const file = join(dir, "daemon.stop");
    writePrivateFileSync(file, JSON.stringify({ pid: 4242, id: ID }));
    removeStopFileIf((request) => request.pid === 5151, file);
    expect(existsSync(file)).toBe(true);
    removeStopFileIf((request) => request.pid === 4242, file);
    expect(existsSync(file)).toBe(false);
    removeStopFileIf(() => true, file);
    expect(existsSync(file)).toBe(false);
  });
});

describe("the PID file", () => {
  it("reads a PID", () => {
    const file = join(dir, "daemon.pid");
    for (const [text, pid] of [
      ["1234", 1234],
      ["1234\n", 1234],
      ["  42  ", 42],
      ["2147483647", 2147483647],
    ] as const) {
      writeFileSync(file, text);
      expect(pidInFile(file), JSON.stringify(text)).toBe(pid);
    }
  });

  it("never gives -1 or 0, which would signal every process the user has, or the process group", () => {
    const file = join(dir, "daemon.pid");
    for (const text of ["-1", "0", "000", "", "\n", "12abc", "1e3", "0x10", "12 34", "+5", "99999999999", "2147483648"]) {
      writeFileSync(file, text);
      expect(pidInFile(file), JSON.stringify(text)).toBeNull();
    }
    expect(pidInFile(join(dir, "missing.pid"))).toBeNull();
  });

  it("is removed only when it names the PID asked", () => {
    const file = join(dir, "daemon.pid");
    writeFileSync(file, "4242");
    removePidFileIf(5151, file);
    expect(readFileSync(file, "utf-8")).toBe("4242");
    removePidFileIf(4242, file);
    expect(pidInFile(file)).toBeNull();
    expect(() => removePidFileIf(4242, file)).not.toThrow();
  });

  // On Windows each check runs PowerShell, which takes a second or two.
  it("names the daemon only when the process is confirmed to be one", { timeout: 120_000 }, async () => {
    expect(confirmedDaemonInPidFile()).toBeNull();

    writeFileSync(PID_FILE, String(process.pid));
    expect(confirmedDaemonInPidFile()).toBeNull();

    writeFileSync(PID_FILE, String(NO_SUCH_PID));
    expect(confirmedDaemonInPidFile()).toBeNull();

    // A PID reused by another program: alive, and not the daemon.
    writeFileSync(PID_FILE, String(await sleeper(join(home.dir, "some-other-program.js"))));
    expect(confirmedDaemonInPidFile()).toBeNull();

    const daemon = await sleeper(join(home.dir, "dist", "daemon", "worker.js"));
    writeFileSync(PID_FILE, String(daemon));
    // On Windows too, through PowerShell (engram#640).
    expect(confirmedDaemonInPidFile()).toBe(daemon);
  });
});

describe("telling the daemon's process from others", () => {
  // The same on every platform: on Windows through PowerShell (engram#640),
  // which takes a second or two each time.
  it("is the daemon only when the user's process runs the worker's script", { timeout: 120_000 }, async () => {
    expect(identifyProcess(process.pid)).toBe("other");
    expect(identifyProcess(await sleeper(join(home.dir, "dist", "daemon", "worker.js")))).toBe("daemon");
    // A plist from before 0.4.2 starts worker-main.js.
    expect(identifyProcess(await sleeper(join(home.dir, "dist", "daemon", "worker-main.js")))).toBe("daemon");
    // Windows puts a path with a space in quotes. Letters outside ASCII
    // come through PowerShell as they are, whatever the console's code page.
    expect(identifyProcess(await sleeper(join(home.dir, "Zoë ソウタ", "dist", "daemon", "worker.js")))).toBe("daemon");
    for (const script of [
      "worker.js",
      join("dist", "daemon", "worker.json"),
      join("dist", "daemon", "my-worker.js"),
      join("my-dist", "daemon", "worker.js"),
    ]) {
      expect(identifyProcess(await sleeper(join(home.dir, script))), script).toBe("other");
    }
    expect(identifyProcess(NO_SUCH_PID)).toBe("other");
  });

  it("says unknown when PowerShell can't be run on Windows, which is never taken for the daemon", () => {
    const platform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    vi.stubEnv("SystemRoot", join(dir, "no-windows"));
    try {
      expect(identifyProcess(process.pid)).toBe("unknown");
    } finally {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      vi.unstubAllEnvs();
    }
  });

  it("knows a process is alive", () => {
    expect(alive(process.pid)).toBe(true);
    expect(alive(NO_SUCH_PID)).toBe(false);
  });
});

describe("identifying a process on Windows (engram#640)", () => {
  const ME = "S-1-5-21-1004336348-1177238915-682003330-1001";
  const SOMEONE_ELSE = "S-1-5-21-1004336348-1177238915-682003330-1002";
  const WORKER = '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Op Name\\AppData\\Roaming\\npm\\node_modules\\@getengram\\cli\\dist\\daemon\\worker.js"';

  /** A command line as IDENTIFY_STATEMENTS gives it: its character codes, joined by commas. */
  function codes(text: string): string {
    return Array.from({ length: text.length }, (_, i) => text.charCodeAt(i)).join(",");
  }

  /** What IDENTIFY_STATEMENTS prints for a process; `command` as plain text, null for none. */
  function printed(found: { owner?: unknown; me?: unknown; command?: string | null } = {}): string {
    const { owner = ME, me = ME, command = WORKER } = found;
    return `${JSON.stringify({ owner, me, command: command === null ? null : codes(command) })}\r\n`;
  }

  it("is the daemon for a process of the user's that runs the worker's script", () => {
    expect(windowsIdentity(printed())).toBe("daemon");
    expect(windowsIdentity(printed({ command: "node C:/Users/op/cli/dist/daemon/worker-main.js" }))).toBe("daemon");
    // Quotes and backslashes come through as they are.
    expect(windowsIdentity(printed({ command: `${WORKER} --x "y \\"z\\""` }))).toBe("daemon");
    // So do letters outside ASCII, which the console's code page can't show.
    expect(windowsIdentity(printed({ command: '"C:\\Users\\Zoë ソウタ\\cli\\dist\\daemon\\worker.js"' }))).toBe("daemon");
    // Windows writes SIDs in capitals; either way, it is the same user.
    expect(windowsIdentity(printed({ owner: ME.toLowerCase() }))).toBe("daemon");
  });

  it("is another program for another script, another user's process, or none at all", () => {
    for (const command of [
      '"C:\\Windows\\System32\\notepad.exe"',
      "node C:\\Users\\op\\dist\\daemon\\worker.json",
      "node C:\\Users\\op\\dist\\daemon\\my-worker.js",
      "node C:\\Users\\op\\my-dist\\daemon\\worker.js",
      "",
    ]) {
      expect(windowsIdentity(printed({ command })), command).toBe("other");
    }
    expect(windowsIdentity(printed({ owner: SOMEONE_ELSE }))).toBe("other");
    expect(windowsIdentity("none\r\n")).toBe("other");
    // Windows PowerShell can start its output with a byte-order mark.
    expect(windowsIdentity("\uFEFFnone\r\n")).toBe("other");
  });

  it("reads the last line: anything PowerShell warns of comes before it", () => {
    expect(windowsIdentity(`WARNING: something PowerShell says\r\n${printed()}\r\n`)).toBe("daemon");
  });

  it("says unknown when Windows won't say, as for a process run as administrator", () => {
    expect(windowsIdentity(printed({ command: null }))).toBe("unknown");
    expect(windowsIdentity(printed({ owner: null }))).toBe("unknown");
    expect(windowsIdentity(printed({ me: null }))).toBe("unknown");
  });

  it("says unknown for anything else, and never takes it for the daemon", () => {
    for (const out of [
      "",
      "\r\n",
      "not json",
      "null",
      "42",
      "[]",
      '"none"',
      printed({ owner: "Administrator" }),
      printed({ owner: "S-1-5-21-1-x", me: "S-1-5-21-1-x" }),
      printed({ me: 1001 }),
      // A command line as plain text, not character codes, isn't trusted:
      // the console's code page may have changed it.
      `${JSON.stringify({ owner: ME, me: ME, command: WORKER })}\r\n`,
      `${JSON.stringify({ owner: ME, me: ME, command: "65,,66" })}\r\n`,
      `${JSON.stringify({ owner: ME, me: ME, command: "65,66," })}\r\n`,
      `${JSON.stringify({ owner: ME, me: ME, command: "65,65536" })}\r\n`,
      `${JSON.stringify({ owner: ME, me: ME, command: ["65", "66"] })}\r\n`,
    ]) {
      expect(windowsIdentity(out), out).toBe("unknown");
    }
  });

  it("runs Windows PowerShell with the PID only in the environment", () => {
    const command = windowsIdentifyCommand(4242, "C:\\Windows");
    expect(command.file).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(command.args).toEqual(["-NoProfile", "-NonInteractive", "-Command", IDENTIFY_STATEMENTS.join("; ")]);
    expect(command.env).toEqual({ ENGRAM_IDENTIFY_PID: "4242" });
    expect(command.args.join(" ")).not.toContain("4242");
    expect(windowsIdentifyCommand(4, "D:\\WINDOWS").file).toBe(
      "D:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });

  it("builds a script the Windows command line passes through unchanged, with no .NET calls", () => {
    const script = windowsIdentifyCommand(4242, "C:\\Windows").args[3];
    // Double quotes and line breaks are what Windows argument quoting rewrites.
    expect(script).not.toMatch(/["\r\n]/);
    expect(IDENTIFY_STATEMENTS[0]).toBe("$ErrorActionPreference = 'Stop'");
    // Constrained Language allows none of these (see the test below, on Windows).
    expect(script).not.toMatch(/::|New-Object|Add-Type|\[System\.|\.Invoke\(/i);
    // Nothing that turns off PowerShell's own checks, or hides what it runs.
    const flags = windowsIdentifyCommand(4242).args.join(" ").toLowerCase();
    for (const flag of ["-encodedcommand", "-executionpolicy", "bypass", "-file"]) {
      expect(flags).not.toContain(flag);
    }
  });

  // On Windows only: real PowerShell, locked down the way AppLocker and WDAC
  // lock it, and a real process of this test's.
  it.runIf(!POSIX)("identifies the daemon where PowerShell runs in Constrained Language", { timeout: 120_000 }, async () => {
    const pid = await sleeper(join(home.dir, "dist", "daemon", "worker.js"));
    const { file, env } = windowsIdentifyCommand(pid);
    // The scripts come in environment variables, and run after the switch:
    // Constrained Language applies to what is parsed after it.
    const out = execFileSync(
      file,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        [
          "$ErrorActionPreference = 'Stop'",
          "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'",
          "'mode=' + $ExecutionContext.SessionState.LanguageMode",
          "try { Invoke-Expression $env:ENGRAM_TEST_DOTNET; 'dotnet=allowed' } catch { 'dotnet=blocked' }",
          "Invoke-Expression $env:ENGRAM_TEST_SCRIPT",
        ].join("; "),
      ],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          ...env,
          // What Constrained Language refuses: proof that it is in force.
          ENGRAM_TEST_DOTNET: "$null = New-Object -TypeName System.Net.WebClient",
          ENGRAM_TEST_SCRIPT: IDENTIFY_STATEMENTS.join("; "),
        },
        windowsHide: true,
        timeout: 60_000,
      },
    );
    const lines = out.split(/\r?\n/).filter(Boolean);
    expect(lines[0]).toBe("mode=ConstrainedLanguage");
    expect(lines[1]).toBe("dotnet=blocked");
    expect(windowsIdentity(out)).toBe("daemon");
  });
});

describe("asking what listens", () => {
  it("finds nothing where nothing listens", async () => {
    expect(await probeDaemon({ endpoint: endpointIn(dir) })).toEqual({ state: "none", stale: false });
  });

  it("says when the socket path can't be used here", async () => {
    expect(await probeDaemon({ endpoint: { unavailable: "too long" } })).toEqual({
      state: "unavailable",
      reason: "too long",
    });
  });

  it("reads a daemon's answer", async () => {
    const endpoint = endpointIn(dir);
    await holder(endpoint, answerLine({ pid: 4242, ready: false }));
    expect(await probeDaemon({ endpoint })).toEqual({
      state: "answered",
      info: {
        pid: 4242,
        version: "0.7.0",
        startedAt: "2026-11-09T10:00:00.000Z",
        id: "0".repeat(32),
        ready: false,
        stopping: false,
        stopFile: false,
      },
    });
  });

  it("takes anything that isn't a daemon's answer for silence", async () => {
    for (const reply of [
      null,
      "",
      "hello\n",
      answerLine({ engram: "not it" }),
      answerLine().trim(),
      Buffer.alloc(2_000, "a"),
    ]) {
      const endpoint = endpointIn(mkdtempSync(join(dir, "r")));
      await holder(endpoint, reply);
      expect(await probeDaemon({ endpoint, timeoutMs: 300 }), String(reply).slice(0, 40)).toEqual({
        state: "silent",
      });
    }
  });

  it.skipIf(!POSIX)("finds a socket file left by a daemon that didn't exit cleanly", async () => {
    const endpoint = endpointIn(dir);
    await staleSocket(endpoint.path);
    expect(await probeDaemon({ endpoint })).toEqual({ state: "none", stale: true });
  });

  it.skipIf(!POSIX)("asks only a socket: never a file or a link at its path", async () => {
    const endpoint = endpointIn(dir);
    writeFileSync(endpoint.path, "not a socket\n");
    expect(await probeDaemon({ endpoint })).toEqual({
      state: "unavailable",
      reason: "~/.engram/daemon.sock is there but isn't a socket",
    });

    // A link to a daemon that answers somewhere else isn't followed.
    unlinkSync(endpoint.path);
    const elsewhere = endpointIn(mkdtempSync(join(dir, "elsewhere")));
    await holder(elsewhere, answerLine());
    symlinkSync(elsewhere.path, endpoint.path);
    expect(await probeDaemon({ endpoint })).toEqual({
      state: "unavailable",
      reason: "~/.engram/daemon.sock is there but isn't a socket",
    });
  });
});

describe("taking the endpoint", () => {
  it("answers as this process once it holds it, and only its user can reach it", async () => {
    const endpoint = endpointIn(dir);
    const umask = process.umask();
    const held = heldOf(await lock(endpoint));
    expect(process.umask()).toBe(umask);
    expect(held.id).toMatch(/^[0-9a-f]{32}$/);
    if (POSIX) expect(lstatSync(endpoint.path).mode & 0o077).toBe(0);
    expect(await probeDaemon({ endpoint })).toEqual({
      state: "answered",
      info: {
        pid: process.pid,
        version: VERSION,
        startedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
        id: held.id,
        ready: false,
        stopping: false,
        stopFile: false,
      },
    });
  });

  it("gives every client one line and lets it go, and never reads what a client sends", async () => {
    const endpoint = endpointIn(dir);
    const held = heldOf(await lock(endpoint));
    const reply = await exchange(endpoint, Buffer.alloc(256 * 1024, "x"));
    expect(reply.endsWith("\n")).toBe(true);
    expect(reply.trim().split("\n")).toHaveLength(1);
    expect(parseAnswer(reply.trim())).toMatchObject({ pid: process.pid, id: held.id });
    // and still answers the next one
    expect(await probeDaemon({ endpoint })).toMatchObject({ state: "answered", info: { id: held.id } });
  });

  it("is refused to a second taker while the first holds it", async () => {
    const endpoint = endpointIn(dir);
    const first = heldOf(await lock(endpoint));
    expect(await lock(endpoint)).toEqual({
      state: "taken",
      taken: { why: "socket", info: expect.objectContaining({ pid: process.pid, id: first.id }) },
    });
  });

  it("is refused while another daemon holds it", async () => {
    const endpoint = endpointIn(dir);
    await holder(endpoint, answerLine({ pid: 4242, version: "0.6.9" }));
    expect(await lock(endpoint)).toEqual({
      state: "taken",
      taken: { why: "socket", info: expect.objectContaining({ pid: 4242, version: "0.6.9" }) },
    });
  });

  it("is refused while something holds it and doesn't answer: a daemon busy starting", async () => {
    const endpoint = endpointIn(dir);
    await holder(endpoint, null);
    expect(await lock(endpoint)).toEqual({ state: "taken", taken: { why: "silent" } });
  });

  it("waits for a daemon that is stopping, then takes over", async () => {
    const endpoint = endpointIn(dir);
    const stopping = await holder(endpoint, answerLine({ pid: 4242, stopping: true }));
    setTimeout(() => void stopping.stop(), 600);
    const started = Date.now();
    const result = await lock(endpoint);
    expect(result.state).toBe("held");
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    expect(await probeDaemon({ endpoint })).toMatchObject({ state: "answered", info: { pid: process.pid } });
  });

  it("can be taken again once let go", async () => {
    const endpoint = endpointIn(dir);
    const first = heldOf(await lock(endpoint));
    const closed = new Promise((resolve) => first.server.once("close", resolve));
    unlockEndpoint(first);
    if (POSIX) {
      expect(isSocket(endpoint.path)).toBe(false);
    } else {
      // A named pipe goes once the server's last instance has closed.
      await closed;
    }
    const second = heldOf(await lock(endpoint));
    expect(second.id).not.toBe(first.id);
    expect(await probeDaemon({ endpoint })).toMatchObject({ state: "answered", info: { id: second.id } });
  });

  it.skipIf(!POSIX)("removes a socket file left by a daemon that didn't exit cleanly, and takes it", async () => {
    const endpoint = endpointIn(dir);
    await staleSocket(endpoint.path);
    const logged: string[] = [];
    const held = heldOf(await lock(endpoint, { log: (msg) => logged.push(msg) }));
    expect(logged).toEqual(["removed a daemon.sock left by a daemon that didn't exit cleanly"]);
    expect(await probeDaemon({ endpoint })).toMatchObject({ state: "answered", info: { id: held.id } });
  });

  it.skipIf(!POSIX)("keeps a socket that refuses connections while the PID file names a running daemon", async () => {
    // macOS refuses connections while a live daemon's backlog is full, and a
    // daemon from before engram#612 has no socket at all.
    const endpoint = endpointIn(dir);
    await staleSocket(endpoint.path);
    const daemon = await sleeper(join(home.dir, "dist", "daemon", "worker.js"));
    writeFileSync(PID_FILE, String(daemon));
    expect(await lock(endpoint)).toEqual({ state: "taken", taken: { why: "pidfile", pid: daemon } });
    expect(isSocket(endpoint.path)).toBe(true);
  });

  it.skipIf(!POSIX)("doesn't take a PID file naming another program for a daemon", async () => {
    const endpoint = endpointIn(dir);
    await staleSocket(endpoint.path);
    writeFileSync(PID_FILE, String(await sleeper(join(home.dir, "some-other-program.js"))));
    expect((await lock(endpoint)).state).toBe("held");
  });

  it.skipIf(!POSIX)("never removes a socket another start bound while this one settled", async () => {
    const endpoint = endpointIn(dir);
    const locking = lock(endpoint, { settleMs: 400 });
    await until(() => isSocket(endpoint.path));
    // The other start found this one's socket stale, removed it and bound its own.
    unlinkSync(endpoint.path);
    await holder(endpoint, answerLine({ pid: 4242 }));
    expect(await locking).toEqual({
      state: "taken",
      taken: { why: "socket", info: expect.objectContaining({ pid: 4242 }) },
    });
    expect(await probeDaemon({ endpoint })).toMatchObject({ state: "answered", info: { pid: 4242 } });
  });

  it.skipIf(!POSIX)("leaves a file or a link at its path as it is", async () => {
    const endpoint = endpointIn(dir);
    writeFileSync(endpoint.path, "not a socket\n");
    expect(await lock(endpoint)).toEqual({
      state: "unavailable",
      reason: "~/.engram/daemon.sock is there but isn't a socket",
    });
    expect(readFileSync(endpoint.path, "utf-8")).toBe("not a socket\n");

    unlinkSync(endpoint.path);
    const target = join(dir, "target");
    writeFileSync(target, "left alone\n");
    symlinkSync(target, endpoint.path);
    expect((await lock(endpoint)).state).toBe("unavailable");
    expect(lstatSync(endpoint.path).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("left alone\n");
  });

  it.skipIf(!POSIX)("creates ~/.engram, private, when there is none", async () => {
    const engram = join(dir, "new");
    heldOf(await lock(endpointIn(engram)));
    expect(statSync(engram).mode & 0o777).toBe(0o700);
  });

  it.skipIf(!POSIX)("removes its own socket file when let go, and never one that has replaced it", async () => {
    const endpoint = endpointIn(dir);
    const own = heldOf(await lock(endpoint));
    unlockEndpoint(own);
    expect(isSocket(endpoint.path)).toBe(false);

    const replaced = heldOf(await lock(endpoint));
    unlinkSync(endpoint.path);
    await holder(endpoint, answerLine({ pid: 4242 }));
    unlockEndpoint(replaced);
    expect(isSocket(endpoint.path)).toBe(true);
    expect(await probeDaemon({ endpoint })).toMatchObject({ state: "answered", info: { pid: 4242 } });
  });
});

// A plain stat of a socket made Node resolve the next package it loaded to
// its symlink, not to where it is, and that package then couldn't find its
// own dependencies: `engram status` couldn't open the local queue while a
// daemon was running.
describe.skipIf(!POSIX)("loading modules after the socket is looked at (engram#612)", () => {
  it("finds a package behind a symlinked node_modules after asking a daemon, and after letting go", async () => {
    const req = createRequire(join(dir, "app", "main.js"));
    // A running CLI has resolved its own packages: the folders on the way are known.
    linkedPackage(dir, "first");
    req.resolve("first");

    const endpoint = endpointIn(dir);
    await holder(endpoint, answerLine());
    const second = linkedPackage(dir, "second");
    // Node reads back whatever was looked at last: start from a folder.
    statSync(dir);
    expect(await probeDaemon({ endpoint })).toMatchObject({ state: "answered" });
    expect(req.resolve("second")).toBe(second);

    const held = heldOf(await lock(endpointIn(mkdtempSync(join(dir, "l")))));
    const third = linkedPackage(dir, "third");
    statSync(dir);
    unlockEndpoint(held);
    expect(req.resolve("third")).toBe(third);
  });
});

// Last: what this process answers can't be put back once marked.
describe("the daemon's answer as it starts and stops", () => {
  it("is ready once the worker says so, and stopping once it starts to shut down", async () => {
    const endpoint = endpointIn(dir);
    heldOf(await lock(endpoint));
    expect(await probeDaemon({ endpoint })).toMatchObject({ info: { ready: false, stopping: false } });
    markReady();
    expect(await probeDaemon({ endpoint })).toMatchObject({ info: { ready: true, stopping: false } });
    markStopping();
    expect(await probeDaemon({ endpoint })).toMatchObject({ info: { ready: true, stopping: true } });
  });
});
