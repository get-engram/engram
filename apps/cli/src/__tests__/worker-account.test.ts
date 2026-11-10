import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedMessage, SessionMeta } from "../daemon/types.js";

/**
 * engram#685 — the daemon read the server once, at start, and the key every
 * few seconds, so a key saved for one server could be sent to another, and
 * a config.json it couldn't read at start meant the default server. It now
 * reads the key and its server together, and sends nothing until it has
 * read them.
 *
 * The real worker, in a temp home, with the lock, status.json and the
 * folders to watch out of the way, and fetch answered by two fake servers:
 * nothing here takes the real daemon's lock, touches the real ~/.engram,
 * starts a process, or sends a request anywhere. A request to any other
 * server, the default one included, fails the test.
 */

type Sent = { kind: "request"; server: string; path: string; key: string; tool?: string; hashes?: string[] };
type Line = { kind: "log"; line: string };

const { home, net } = vi.hoisted(() => ({
  home: { dir: "" },
  net: {
    /** Requests and the syncer's log lines, in the order they happened. */
    events: [] as Array<Sent | Line>,
    violations: [] as string[],
    /** Servers that can't be reached. */
    down: new Set<string>(),
    conversations: new Map<string, { server: string; key: string; messages: string[] }>(),
    seq: 0,
    /** What `engram stop` and SIGTERM call. */
    stop: null as (() => void) | null,
  },
}));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));

// Nothing the worker does here starts a process.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const refuse = (name: string) => () => {
    net.violations.push(`child_process.${name}`);
    throw new Error(`no ${name} in this test`);
  };
  return {
    ...actual,
    spawn: refuse("spawn"),
    spawnSync: refuse("spawnSync"),
    exec: refuse("exec"),
    execSync: refuse("execSync"),
    execFile: refuse("execFile"),
    execFileSync: refuse("execFileSync"),
    fork: refuse("fork"),
  };
});

home.dir = mkdtempSync(join(tmpdir(), "engram-685w-"));

const STAGING = "http://staging.example.test";
const OTHER = "http://127.0.0.1:8702";
const SERVERS: Record<string, string> = { [STAGING]: "staging", [OTHER]: "other" };
const KEY_A = "test-key-685-a";
const KEY_B = "test-key-685-b";
/** Each test key's account. */
const ACCOUNT: Record<string, string> = { [KEY_A]: "A", [KEY_B]: "B" };

function rpc(id: unknown, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The two servers. Each message's text starts with the server and account
 * it was queued for ("staging/A:…"), so a server can tell when it is sent
 * something that isn't its own.
 */
async function fakeFetch(input: unknown, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const name = SERVERS[`${url.protocol}//${url.host}`];
  if (!name) {
    net.violations.push(
      url.host === "mcp.getengram.app" ? "a request to the default server" : "a request to a server no test set up",
    );
    throw new TypeError("fetch failed");
  }
  const key = (new Headers(init.headers).get("authorization") ?? "").replace(/^Bearer /, "");
  const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
  const sent: Sent = { kind: "request", server: name, path: url.pathname, key };
  net.events.push(sent);
  if (net.down.has(name)) throw new TypeError("fetch failed");

  if (url.pathname === "/api/account/owned-keys") {
    sent.hashes = body?.key_hashes ?? [];
    return new Response(JSON.stringify({ owned: [] }), { status: 200 });
  }
  if (url.pathname !== "/mcp" || body?.method !== "tools/call") {
    net.violations.push(`${name}: ${url.pathname}`);
    return new Response("not found", { status: 404 });
  }
  const tool: string = body.params.name;
  const args = body.params.arguments;
  sent.tool = tool;
  if (tool === "create_conversation") {
    const id = `${name}_conv_${++net.seq}`;
    net.conversations.set(id, { server: name, key, messages: [] });
    return rpc(body.id, { content: [{ type: "text", text: JSON.stringify({ conversation_id: id }) }] });
  }
  if (tool === "append_messages") {
    const conv = net.conversations.get(args.conversation_id);
    const contents = (args.messages as Array<{ content: string }>).map((m) => m.content);
    const theirs = contents.filter((c) => !c.startsWith(`${name}/${ACCOUNT[key]}:`));
    if (!conv || conv.server !== name || ACCOUNT[conv.key] !== ACCOUNT[key] || theirs.length > 0) {
      net.violations.push(`${name}: ${contents.join(", ")} sent into ${args.conversation_id}`);
      return rpc(body.id, { isError: true, content: [{ type: "text", text: "conversation not found" }] });
    }
    conv.messages.push(...contents);
    const ids = contents.map((_, i) => `msg_${net.seq}_${conv.messages.length}_${i}`);
    return rpc(body.id, {
      content: [{ type: "text", text: JSON.stringify({ appended: contents.length, message_ids: ids }) }],
    });
  }
  net.violations.push(`${name}: ${tool}`);
  return rpc(body.id, { isError: true, content: [{ type: "text", text: "unexpected tool" }] });
}

const requests = () => net.events.filter((e): e is Sent => e.kind === "request");
const to = (server: string) => requests().filter((r) => r.server === server);
/** What a server holds, conversation by conversation. */
const held = (server: string) =>
  [...net.conversations.values()].filter((c) => c.server === server).map((c) => c.messages);

const engramDir = () => join(home.dir, ".engram");

function writeConfig(text: string): void {
  mkdirSync(engramDir(), { recursive: true, mode: 0o700 });
  writeFileSync(join(engramDir(), "config.json"), text, { mode: 0o600 });
}

const configFor = (key: string, server: string) =>
  `${JSON.stringify({ apiKey: key, baseUrl: server, autocapture: "on" }, null, 2)}\n`;

/** Cut off part-way, as an interrupted write or a bad edit leaves it. */
const cutOff = (text: string) => text.slice(0, Math.floor(text.length / 2));

const meta = (sessionId: string): SessionMeta => ({
  sessionId,
  projectDir: "myproj",
  cwd: "/work/myproj",
  host: "claude-code",
});

const msgs = (...contents: string[]): ParsedMessage[] =>
  contents.map((content, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content }));

let written: string[] = [];
const log = () => written.join("");

/** Queue sessions in ~/.engram/daemon.db, as an earlier run of the daemon left them. */
async function seed(fill: (db: import("../daemon/db.js").DaemonDb) => void): Promise<void> {
  const { DaemonDb } = await import("../daemon/db.js");
  const db = new DaemonDb(join(engramDir(), "daemon.db"));
  try {
    fill(db);
  } finally {
    db.close();
  }
}

async function fingerprint(key: string, server: string): Promise<string> {
  const { accountFingerprint } = await import("../daemon/syncer.js");
  return accountFingerprint({ key, server });
}

/** Start the worker, and wait until it is ready. */
async function startWorker(): Promise<void> {
  await import("../daemon/worker-main.js");
  await vi.waitFor(() => expect(log()).toContain("watching for transcripts across 0 host(s)"), {
    timeout: 5_000,
  });
}

/** The real time the worker's file reads take. Timers other than the
 *  daemon's intervals are real. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

/** Let the daemon's intervals fire `times` times, as many seconds go by. */
async function run(times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await vi.advanceTimersByTimeAsync(2_000);
    await settle();
  }
}

/** Let the daemon run until `check` passes. */
async function runUntil(check: () => void): Promise<void> {
  await vi.waitFor(
    async () => {
      await vi.advanceTimersByTimeAsync(2_000);
      check();
    },
    { timeout: 10_000, interval: 25 },
  );
}

/** What `engram stop` does: the worker shuts down, and closes daemon.db. */
async function stopWorker(): Promise<void> {
  const stop = net.stop;
  net.stop = null;
  if (!stop) return;
  stop();
  await vi.waitFor(() => expect(log()).toContain("daemon stopped"), { timeout: 20_000 });
}

beforeEach(() => {
  net.events = [];
  net.violations = [];
  net.down = new Set();
  net.conversations = new Map();
  net.seq = 0;
  net.stop = null;
  written = [];
  // The daemon's flush and key-poll intervals are run by the test; its
  // other timers (shutdown's waits, the pruner's first pass) are real.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  vi.stubGlobal("fetch", fakeFetch);
  for (const name of ["ENGRAM_API_KEY", "ENGRAM_BASE_URL", "ENGRAM_VAULT_KEY"]) vi.stubEnv(name, undefined);
  vi.doMock("../daemon/instance.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../daemon/instance.js")>()),
    claimDaemonLock: vi.fn(async () => ({ state: "held" })),
    setStopHandler: vi.fn((fn: () => void) => {
      net.stop = fn;
    }),
    setDisplacedHandler: vi.fn(),
    markReady: vi.fn(),
    markStopping: vi.fn(),
    releaseDaemonLock: vi.fn(),
  }));
  vi.doMock("../daemon/ownership.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../daemon/ownership.js")>()),
    foreignFiles: vi.fn(() => null),
  }));
  vi.doMock("../daemon/status.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../daemon/status.js")>()),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
    recordCaptureStall: vi.fn(),
    recordCaptureResumed: vi.fn(),
    recordSignedOut: vi.fn(),
    recordSignedIn: vi.fn(),
    updatePending: vi.fn(),
    recordNextRetry: vi.fn(),
    recordDeletesRefused: vi.fn(),
  }));
  // The worker sets a umask of 0o077: not on this process. It exits at the
  // end of a shutdown: not this process.
  vi.spyOn(process, "umask").mockReturnValue(0o022);
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  }) as never);
  const line = (...args: unknown[]) => {
    const text = args.map(String).join(" ");
    written.push(`${text}\n`);
    net.events.push({ kind: "log", line: text });
  };
  vi.spyOn(console, "log").mockImplementation(line);
  vi.spyOn(console, "error").mockImplementation(line);
});

afterEach(async () => {
  await stopWorker().catch(() => {});
  const lines = log();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const path of ["instance", "ownership", "status"]) vi.doUnmock(`../daemon/${path}.js`);
  vi.resetModules();
  rmSync(engramDir(), { recursive: true, force: true });
  expect(net.violations).toEqual([]);
  // Neither a key nor a server's address (which can carry credentials) is logged.
  expect(lines).not.toMatch(/test-key-685|staging\.example|127\.0\.0\.1|mcp\.getengram\.app/);
});

afterAll(() => rmSync(home.dir, { recursive: true, force: true }));

describe("the worker reads the key and its server together (engram#685)", () => {
  it("config.json unreadable at start: nothing is sent until it is read, then all of it goes to the server it names", async () => {
    writeConfig(cutOff(configFor(KEY_A, STAGING)));
    // Captured while no key was in use, by an earlier run.
    await seed((db) => db.enqueuePendingSession("s0", meta("s0"), msgs("staging/A:q0", "staging/A:q1"), null));

    await startWorker();
    expect(log()).toContain(
      "nothing is captured or sent until it can be read; will keep trying",
    );
    expect(log()).toContain("server: baseUrl in ~/.engram/config.json, else the default (read with the key)");
    await run(5);
    expect(requests()).toEqual([]);
    expect(log()).not.toContain("[engram] signed out");

    writeConfig(configFor(KEY_A, STAGING));
    await runUntil(() => expect(held("staging")).toEqual([["staging/A:q0", "staging/A:q1"]]));
    expect(requests().length).toBeGreaterThan(0);
    expect(requests().every((r) => r.server === "staging" && r.key === KEY_A)).toBe(true);
    expect(log()).toContain("[engram] signed in — capture and sync resumed");
  });

  it("a new key and server together: from the switch on, everything goes to the new server, and nothing queued for the old one", async () => {
    writeConfig(configFor(KEY_A, STAGING));
    const onStaging = await fingerprint(KEY_A, STAGING);
    const onOther = await fingerprint(KEY_B, OTHER);
    await seed((db) => {
      db.enqueuePendingSession("s1", meta("s1"), msgs("staging/A:m1"), onStaging);
      db.enqueuePendingSession("s2", meta("s2"), msgs("other/B:b1"), onOther);
    });
    net.down.add("staging");

    await startWorker();
    await runUntil(() => expect(to("staging").length).toBeGreaterThan(0));
    expect(to("other")).toEqual([]);

    writeConfig(configFor(KEY_B, OTHER));
    await runUntil(() => expect(held("other")).toEqual([["other/B:b1"]]));
    const switched = net.events.findIndex(
      (e) =>
        e.kind === "log" &&
        e.line === "[engram] new API key and server found — capturing and sending with them from now on",
    );
    expect(switched).toBeGreaterThan(-1);
    const after = net.events.slice(switched).filter((e): e is Sent => e.kind === "request");
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((r) => r.server === "other" && r.key === KEY_B)).toBe(true);
    // The new server isn't asked about the old key's rows: they are another server's.
    expect(to("other").filter((r) => r.hashes !== undefined)).toEqual([]);

    // Staging is reachable again, but its key is no longer configured: what
    // was queued for it stays, for it.
    net.down.delete("staging");
    await run(3);
    expect(net.events.slice(switched).some((e) => e.kind === "request" && e.server === "staging")).toBe(false);
    await stopWorker();
    const { DaemonDb } = await import("../daemon/db.js");
    const db = new DaemonDb(join(engramDir(), "daemon.db"), { readonly: true });
    try {
      expect(db.getPendingCount(onStaging)).toBe(1);
      expect(db.getPendingCount()).toBe(1);
    } finally {
      db.close();
    }
  });

  it("ENGRAM_API_KEY without ENGRAM_BASE_URL: the server is still config.json's, so nothing is sent until it is read", async () => {
    vi.stubEnv("ENGRAM_API_KEY", KEY_A);
    writeConfig(cutOff(configFor(KEY_B, STAGING)));
    await seed((db) => db.enqueuePendingSession("s0", meta("s0"), msgs("staging/A:q0"), null));

    await startWorker();
    expect(log()).toContain("API key: ENGRAM_API_KEY (fixed for this process;");
    expect(log()).toContain("nothing is captured or sent until it can be read; will keep trying");
    await run(5);
    expect(requests()).toEqual([]);

    // The file's key is another account's: the variable's is the one used.
    writeConfig(configFor(KEY_B, STAGING));
    await runUntil(() => expect(held("staging")).toEqual([["staging/A:q0"]]));
    expect(requests().every((r) => r.server === "staging" && r.key === KEY_A)).toBe(true);
  });
});
