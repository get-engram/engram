#!/usr/bin/env node
/**
 * One daemon per user (engram#612), under the real daemon from the built
 * CLI, against a fake Engram server on 127.0.0.1. The unit tests take the
 * lock in-process; this runs the worker processes, the CLI commands and the
 * socket as they ship, and checks:
 *
 *   - Two `engram start` at once, and launchd starting the worker beside a
 *     running daemon, leave one daemon; the others exit 0, and say why in
 *     daemon.log. Each message reaches the server once.
 *   - A daemon killed outright leaves its socket and PID file. `engram
 *     status` says stopped, and the next start clears the socket and runs.
 *   - `engram stop` returns once the daemon has exited, and a PID file
 *     naming a process that isn't the daemon is neither reported as it nor
 *     signalled.
 *   - A socket removed from under a running daemon is bound again, and a
 *     daemon started in its place meanwhile takes over: the first stops.
 *   - A daemon from before #612 (no socket, found by its PID file) is
 *     reported as older, not run beside, and `engram stop` stops it.
 *
 * Usage, after `pnpm build`:  node scripts/e2e-daemon-lock.mjs
 *
 * Everything happens under a temporary home with a made-up key, and the CLI
 * runs with an environment of its own (no ENGRAM_API_KEY from your shell),
 * so it never touches your ~/.engram or your account. It signals only
 * processes it started: workers of this checkout's build that weren't
 * running before it began, and its own stand-ins. launchctl, osascript and
 * notify-send are stubs on its PATH. POSIX only: on Windows it skips.
 *
 * It takes two minutes or so: a daemon checks its socket every 30 seconds.
 */
import http from "node:http";
import net from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync, chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  rmSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  console.log("skipped: the stubs and paths here are POSIX-only");
  process.exit(0);
}

const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const WORKER = fileURLToPath(new URL("../dist/daemon/worker.js", import.meta.url));
if (!existsSync(CLI) || !existsSync(WORKER)) {
  console.error(`no build at ${CLI}: run 'pnpm build' first`);
  process.exit(2);
}
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version;
const node = process.execPath;

// Made up on each run: it only exists on the fake server below.
const KEY = `engram_sk_live_e2e_lock_${randomBytes(12).toString("hex")}`;
const fp = (k) => createHash("sha256").update(k).digest("hex");
const redact = (s) => s.replace(/engram_sk_live_e2e_\w*/g, "<test key>");

// ── The workers this checkout's build runs ──────────────────────────────────
// Matched by the full path of this build's worker.js. Any running before this
// test began (a daemon of yours from this checkout) is never counted or
// signalled.
function psWorkers() {
  const out = execFileSync("/bin/ps", ["-A", "-ww", "-o", "pid=,args="], { encoding: "utf-8" });
  const found = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && m[2].trim().endsWith(` ${WORKER}`)) found.push(Number(m[1]));
  }
  return found;
}
const BEFORE = new Set(psWorkers());
const workers = () => psWorkers().filter((pid) => !BEFORE.has(pid));

// ── The fake server ─────────────────────────────────────────────────────────
const server = {
  conversations: new Map(), // id -> { messages }
  log: [], // { t, op, key, conv?, contents? }
  nextConv: 1,
};
const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
const toolResult = (id, value, isError = false) => ({
  jsonrpc: "2.0",
  id,
  result: {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  },
});
const stored = () => [...server.conversations.values()].reduce((n, c) => n + c.messages.length, 0);
const srv = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const url = new URL(req.url ?? "/", "http://fake");
  const auth = req.headers.authorization ?? "";
  const valid = auth === `Bearer ${KEY}`;
  const record = (op, extra = {}) => server.log.push({ t: Date.now(), op, key: valid ? "KEY" : "none", ...extra });
  if (!valid) {
    record(`${req.method} ${url.pathname} refused: no valid key`);
    return send(res, 401, { error: "unauthorized" });
  }
  if (req.method === "POST" && url.pathname === "/mcp") {
    const rpc = JSON.parse(body);
    if (rpc.method !== "tools/call") {
      record(`rpc ${rpc.method}`);
      return send(res, 200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "method not found" } });
    }
    const { name, arguments: args = {} } = rpc.params ?? {};
    if (name === "list_conversations") {
      record("list");
      return send(res, 200, toolResult(rpc.id, { conversations: [], total: 0 }));
    }
    if (name === "create_conversation") {
      const id = `conv_${server.nextConv++}`;
      server.conversations.set(id, { messages: [] });
      record("create", { conv: id });
      return send(res, 200, toolResult(rpc.id, { conversation_id: id }));
    }
    if (name === "append_messages") {
      const contents = (args.messages ?? []).map((m) => String(m.content));
      const conv = server.conversations.get(args.conversation_id);
      if (!conv) {
        record("append refused", { conv: args.conversation_id });
        return send(res, 200, toolResult(rpc.id, "Conversation not found", true));
      }
      conv.messages.push(...contents);
      record("append", { conv: args.conversation_id, contents });
      return send(res, 200, toolResult(rpc.id, {
        appended: contents.length,
        message_ids: contents.map(() => `msg_${randomUUID()}`),
      }));
    }
    record(`tool ${name}`);
    return send(res, 200, toolResult(rpc.id, `unknown tool ${name}`, true));
  }
  if (req.method === "POST" && url.pathname === "/api/account/owned-keys") {
    const { key_hashes = [] } = JSON.parse(body || "{}");
    const owned = key_hashes.filter((h) => h === fp(KEY));
    record("owned-keys", { asked: key_hashes.length, owned: owned.length });
    return send(res, 200, { owned });
  }
  if (req.method === "GET" && url.pathname === "/api/account") {
    record("account");
    return send(res, 200, {
      org_id: "org_e2e", email: "e2e@example.test", name: null, tier: "pro", deleted_at: null, purge_at: null,
    });
  }
  if (req.method === "GET" && url.pathname === "/api/usage") {
    // The fields `engram status` reads (apps/mcp-server/src/routes/usage.ts).
    record("usage");
    return send(res, 200, {
      tier: "pro",
      period: null,
      messages: { used: stored(), limit: -1 },
      storage: { used: stored(), limit: -1 },
      searches: { used: 0, limit: -1 },
    });
  }
  record(`${req.method} ${url.pathname} 404`);
  return send(res, 404, { error: "not_found" });
});
await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${srv.address().port}`;

// ── The temporary home, the stubs, the CLI ──────────────────────────────────
// A socket's path can be 103 bytes at most on macOS, so a long TMPDIR won't do.
const root = mkdtempSync(join(Buffer.byteLength(tmpdir()) <= 60 ? tmpdir() : "/tmp", "e2e-612-"));
const home = join(root, "home");
const project = join(home, ".claude", "projects", "-work-proj");
mkdirSync(project, { recursive: true });
mkdirSync(join(root, "tmp"));
const fakeBin = join(root, "bin");
mkdirSync(fakeBin);
const STUB_LOG = join(root, "stubs.log");
for (const [name, status] of [["osascript", 0], ["launchctl", 1], ["notify-send", 0]]) {
  writeFileSync(join(fakeBin, name), `#!/bin/sh\necho "${name} $*" >> "${STUB_LOG}"\nexit ${status}\n`);
  chmodSync(join(fakeBin, name), 0o755);
}
const env = {
  PATH: `${fakeBin}:${dirname(node)}:/bin`,
  HOME: home,
  TMPDIR: join(root, "tmp"),
  ENGRAM_BASE_URL: baseUrl,
  ENGRAM_NO_AUTOCAPTURE: "1",
};
const ENGRAM_DIR = join(home, ".engram");
const LOG_FILE = join(ENGRAM_DIR, "daemon.log");
const PID_FILE = join(ENGRAM_DIR, "daemon.pid");
const SOCK = join(ENGRAM_DIR, "daemon.sock");
if (Buffer.byteLength(SOCK) > 100) {
  console.error(`the socket path would be ${Buffer.byteLength(SOCK)} bytes: set TMPDIR to a shorter folder`);
  rmSync(root, { recursive: true, force: true });
  process.exit(2);
}

/** Processes this test spawned itself: launchd-style workers and stand-ins. */
const owned = new Set();
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
process.on("SIGINT", () => {
  for (const pid of workers()) process.kill(pid, "SIGKILL");
  for (const child of owned) child.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
  process.exit(130);
});

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) failures++;
  return ok;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Polls `test`, which may be async, until it gives something truthy. */
async function waitFor(what, test, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await test();
    if (v) return v;
    await sleep(200);
  }
  check(false, `${what} (gave up after ${ms / 1000}s)`);
  return null;
}

/** Run the built CLI as a user would. Async: the fake server is in this process. */
function engram(...args) {
  return new Promise((resolve) => {
    const child = spawn(node, [CLI, ...args], { env, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      out = redact(out.replace(/\x1b\[[0-9;]*m/g, ""));
      console.log(`\n$ engram ${redact(args.join(" "))}  (exit ${status})`);
      for (const line of out.trimEnd().split("\n")) console.log(`  │ ${line}`);
      resolve({ status, out });
    });
  });
}

/** The worker started directly, as launchd starts it, its output to daemon.log. */
function launchdWorker() {
  const fd = openSync(LOG_FILE, "a", 0o600);
  const child = spawn(node, [WORKER], { env, cwd: root, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  owned.add(child);
  const exit = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  console.log(`\n(the worker, started directly: pid ${child.pid})`);
  return { pid: child.pid, child, exit };
}

/** A process that isn't the daemon, or with `args`, one that looks like an older one to `ps`. */
function standIn(...args) {
  const child = spawn(node, ["-e", "setInterval(() => {}, 1 << 30)", ...args], { stdio: "ignore" });
  owned.add(child);
  const exit = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return { pid: child.pid, child, exit };
}

/** Settles with what `p` settles with, or with null after `ms`. */
const within = (p, ms) => Promise.race([p, sleep(ms).then(() => null)]);

/** What answers on ~/.engram/daemon.sock: its JSON line, or null. */
function ask() {
  return new Promise((resolve) => {
    let data = "";
    const socket = net.connect(SOCK);
    const done = (v) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => done(null), 1_500);
    socket.on("data", (d) => {
      data += d;
      const end = data.indexOf("\n");
      if (end < 0) return;
      try {
        done(JSON.parse(data.slice(0, end)));
      } catch {
        done(null);
      }
    });
    socket.on("error", () => done(null));
    socket.on("close", () => done(null));
  });
}
const answersReady = async (pid) => {
  const a = await ask();
  return a?.pid === pid && a.ready === true && a.stopping === false;
};

const logText = () => (existsSync(LOG_FILE) ? readFileSync(LOG_FILE, "utf-8") : "");
const logCount = (s) => logText().split("\n").filter((l) => l.includes(s)).length;
const pidFile = () => {
  try {
    const text = readFileSync(PID_FILE, "utf-8").trim();
    return /^\d+$/.test(text) ? Number(text) : text;
  } catch {
    return null;
  }
};
const isSocket = () => {
  try {
    return lstatSync(SOCK).isSocket();
  } catch {
    return false;
  }
};
/** The PID a start or stop names. */
const named = (out) =>
  Number(/(?:Engram daemon started|Engram daemon is starting|Daemon already running|Daemon stopped) \(pid (\d+)\)/.exec(out)?.[1]) ||
  null;

/** A Claude Code session, written to as the test goes. */
function session() {
  const id = randomUUID();
  const file = join(project, `${id}.jsonl`);
  const say = (text) =>
    appendFileSync(
      file,
      JSON.stringify({ type: "user", sessionId: id, cwd: "/work/proj", message: { role: "user", content: text } }) + "\n",
    );
  return { id, say };
}
const said = [];
const say = (s, n) => {
  const text = `lock-e2e m${n}`;
  said.push(text);
  s.say(text);
};
/** How many times the server has `text`. */
const delivered = (text) =>
  [...server.conversations.values()].reduce((n, c) => n + c.messages.filter((m) => m.includes(text)).length, 0);
async function allDeliveredOnce(what) {
  await waitFor(`${what}: every message arrives`, () => said.every((t) => delivered(t) >= 1));
  // Time for a second daemon, had there been one, to send them again.
  await sleep(6_000);
  const counts = said.map((t) => `${t.slice(-2).trim()}×${delivered(t)}`);
  check(said.every((t) => delivered(t) === 1), `${what}: each message reached the server once (${counts.join(", ")})`);
}

const EXITING = "; this one is exiting";
const ALREADY = (pid) => `another daemon is already running (pid ${pid}, version ${VERSION})${EXITING}`;
const OLDER_RUNNING = (pid) =>
  `an older daemon is already running (pid ${pid})${EXITING}. Run 'engram stop' and then 'engram start' to update it`;
const OLDER_HINT = "It's from an older version of Engram";
const REMOVED_STALE = "removed a daemon.sock left by a daemon that didn't exit cleanly";
const LISTENING_AGAIN = "~/.engram/daemon.sock was removed; listening on it again";
const TAKEN_OVER = "another daemon has taken over; this one is stopping";

/**
 * `engram status` read the local queue. Looking at the socket first once
 * kept Node from loading SQLite after it, so status couldn't open the queue
 * while a daemon ran, or after one was killed.
 */
function queueRead(r, when) {
  check(r.out.includes("Pending sync:") && !r.out.includes("Local capture DB unreadable"), `status ${when}: reads the local queue`);
}

/** Two `engram start` at once: both exit 0 and name the one daemon now running. */
async function twoStarts(what, not = null) {
  const exitingBefore = logCount(EXITING);
  const both = await Promise.all([engram("start"), engram("start")]);
  check(both.every((r) => r.status === 0), `${what}: both starts exit 0`);
  const [a, b] = both.map((r) => named(r.out));
  check(a !== null && a === b && a !== not, `${what}: both name the same daemon (${a}, ${b})`);
  // A start that found the daemon running spawned nothing; one that spawned
  // a worker says "started" either way, and all but one of those exited.
  const spawned = both.filter((r) => r.out.includes("Engram daemon started") || r.out.includes("is starting")).length;
  const exiting = logCount(EXITING) - exitingBefore;
  check(spawned >= 1 && exiting === spawned - 1, `${what}: ${spawned} worker(s) started, ${exiting} exited saying why`);
  await waitFor(`${what}: one worker runs`, () => workers().length === 1, 5_000);
  check(JSON.stringify(workers()) === JSON.stringify([a]), `${what}: the one worker is pid ${a} (${workers().join(", ")})`);
  await waitFor(`${what}: it answers on the socket, ready`, () => answersReady(a), 10_000);
  check(pidFile() === a, `${what}: daemon.pid names it (${pidFile()})`);
  return a;
}

/** `engram stop`: it returns once the daemon has exited, and leaves no socket or PID file. */
async function stop(pid, what) {
  const r = await engram("stop");
  check(r.status === 0 && r.out.includes(`Daemon stopped (pid ${pid})`), `${what}: stop says it stopped pid ${pid}`);
  check(!alive(pid), `${what}: pid ${pid} has exited when stop returns`);
  check(!isSocket() && pidFile() === null, `${what}: no socket or PID file left (${isSocket()}, ${pidFile()})`);
}

const startedDaemons = [];
try {
  // ── 1. two starts at once: one daemon ──
  let r = await engram("auth", "login", KEY);
  check(r.status === 0, "auth login exits 0");
  const s1 = session();
  for (const n of [1, 2, 3]) say(s1, n);
  const P = await twoStarts("two starts");
  startedDaemons.push(P);
  check((lstatSync(SOCK).mode & 0o077) === 0, `the socket is the user's alone (${(lstatSync(SOCK).mode & 0o777).toString(8)})`);
  check((statSync(ENGRAM_DIR).mode & 0o777) === 0o700, `~/.engram is 0700 (${(statSync(ENGRAM_DIR).mode & 0o777).toString(8)})`);
  r = await engram("status");
  check(r.out.includes(`Status: running (pid ${P})`), "status: running, the same pid");
  queueRead(r, "while it runs");
  check(!r.out.includes(OLDER_HINT) && !r.out.includes("this CLI is"), "status: no version hint");
  await allDeliveredOnce("two starts");

  // ── 2. launchd starts the worker beside it: that one exits 0, and says why ──
  let w = launchdWorker();
  let ended = await within(w.exit, 15_000);
  check(ended?.code === 0, `it exits 0 (${JSON.stringify(ended)})`);
  check(logCount(ALREADY(P)) >= 1, "daemon.log: another daemon is already running, its pid and version");
  check(await answersReady(P), `pid ${P} still answers`);
  check(JSON.stringify(workers()) === JSON.stringify([P]), "still one worker");

  // ── 3. killed outright: the socket and PID file are left; the next start clears them ──
  check(workers().includes(P) && (await ask())?.pid === P, `pid ${P} is this test's daemon`);
  process.kill(P, "SIGKILL");
  await waitFor(`pid ${P} has exited`, () => !alive(P), 10_000);
  check(isSocket() && pidFile() === P, "the socket and PID file are left behind");
  r = await engram("status");
  check(r.out.includes("Status: stopped"), "status: stopped");
  queueRead(r, "after a kill");
  check(pidFile() === null, "status removed the PID file of a process that has exited");
  const s2 = session();
  say(s1, 4);
  say(s2, 5);
  const removedBefore = logCount(REMOVED_STALE);
  const Q = await twoStarts("after a kill", P);
  startedDaemons.push(Q);
  check(logCount(REMOVED_STALE) - removedBefore === 1, `daemon.log: the dead daemon's socket removed, said once (${logCount(REMOVED_STALE) - removedBefore})`);
  await allDeliveredOnce("after a kill");

  // ── 4. stop returns once it has exited ──
  await stop(Q, "stop");

  // ── 5. a PID file naming another program: not the daemon, not signalled ──
  const F = standIn();
  writeFileSync(PID_FILE, String(F.pid));
  r = await engram("status");
  check(r.out.includes("Status: stopped") && !r.out.includes(`pid ${F.pid}`), "status: stopped, not the other program");
  check(pidFile() === null, "status removed that PID file");
  writeFileSync(PID_FILE, String(F.pid));
  r = await engram("stop");
  check(r.status === 0 && r.out.includes("Daemon is not running."), "stop: not running");
  await sleep(500);
  check(alive(F.pid) && F.child.exitCode === null && F.child.signalCode === null, "the other program was never signalled");

  // A daemon launchd started.
  const R = launchdWorker();
  await waitFor("the launchd-style worker answers, ready", () => answersReady(R.pid));
  startedDaemons.push(R.pid);
  check(pidFile() === R.pid, "daemon.pid names it");

  // ── 6. its socket removed: still found, not run beside, and bound again ──
  unlinkSync(SOCK);
  r = await engram("start");
  check(r.status === 0 && r.out.includes(`Daemon already running (pid ${R.pid})`), "start: already running, its pid");
  check(JSON.stringify(workers()) === JSON.stringify([R.pid]), "start spawned no worker");
  w = launchdWorker();
  ended = await within(w.exit, 15_000);
  check(ended?.code === 0, `a worker started now exits 0 (${JSON.stringify(ended)})`);
  // Found by its PID file; or by its socket, had its check bound it again just before.
  check(
    logCount(OLDER_RUNNING(R.pid)) + logCount(ALREADY(R.pid)) === 1,
    "daemon.log: it found the running daemon, and exited",
  );
  check((await ask())?.pid !== w.pid, "and left no socket of its own");
  // The daemon checks its socket every 30 seconds.
  await waitFor("daemon.log: the daemon listens again", () => logCount(LISTENING_AGAIN) === 1, 70_000);
  check(await answersReady(R.pid), `pid ${R.pid} answers again`);
  check(alive(R.pid) && pidFile() === R.pid, "the same daemon, and its PID file");
  r = await engram("status");
  check(r.out.includes(`Status: running (pid ${R.pid})`) && !r.out.includes(OLDER_HINT), "status: running, no version hint");
  queueRead(r, "once it listens again");

  // ── 7. its socket and PID file removed, and a daemon started in its place: the first stops ──
  let T = null;
  for (let attempt = 1; attempt <= 3 && T === null; attempt++) {
    rmSync(SOCK, { force: true });
    rmSync(PID_FILE, { force: true });
    r = await engram("start");
    const pid = named(r.out);
    // Its check, at that moment, would have bound the socket again first.
    if (r.status === 0 && pid !== null && pid !== R.pid) T = pid;
    else console.log(`(attempt ${attempt}: the first daemon got its socket back first)`);
  }
  check(T !== null && r.out.includes(`Engram daemon started (pid ${T})`), "a new daemon started in its place");
  if (T !== null) startedDaemons.push(T);
  ended = await within(R.exit, 70_000);
  check(ended?.code === 0, `the first daemon exits 0 within a minute (${JSON.stringify(ended)})`);
  check(logCount(TAKEN_OVER) === 1, "daemon.log: another daemon has taken over");
  check(pidFile() === T && (await answersReady(T)), "the PID file and the socket are the new daemon's");
  check(JSON.stringify(workers()) === JSON.stringify([T]), "one worker");
  say(s2, 6);
  await allDeliveredOnce("taken over");

  // ── 8. a daemon from before #612: no socket, found by its PID file ──
  await stop(T, "stop");
  const S = standIn("/e2e-612/dist/daemon/worker.js");
  writeFileSync(PID_FILE, String(S.pid));
  r = await engram("status");
  check(r.out.includes(`Status: running (pid ${S.pid})`) && r.out.includes(OLDER_HINT), "status: running, older");
  const startedBefore = logCount("] daemon started (pid ");
  r = await engram("start");
  check(r.status === 0 && r.out.includes(`Daemon already running (pid ${S.pid})`) && r.out.includes(OLDER_HINT), "start: already running, older");
  await sleep(1_000);
  check(workers().length === 0 && logCount("] daemon started (pid ") === startedBefore, "start spawned no worker");
  w = launchdWorker();
  ended = await within(w.exit, 15_000);
  check(ended?.code === 0, `a worker started now exits 0 (${JSON.stringify(ended)})`);
  check(logCount(OLDER_RUNNING(S.pid)) === 1, "daemon.log: an older daemon is running, and how to update it");
  check(!isSocket(), "it left no socket");
  check(alive(S.pid), "the older daemon still runs");
  r = await engram("stop");
  check(r.status === 0 && r.out.includes(`Daemon stopped (pid ${S.pid})`), "stop stops the older daemon");
  ended = await within(S.exit, 5_000);
  check(ended?.signal === "SIGTERM", `with SIGTERM (${JSON.stringify(ended)})`);
  check(pidFile() === null, "and removes its PID file");
  r = await engram("start");
  const U = named(r.out);
  check(r.status === 0 && r.out.includes(`Engram daemon started (pid ${U})`), "then start starts this version's");
  if (U !== null) {
    startedDaemons.push(U);
    await stop(U, "stop");
  }
} catch (err) {
  check(false, `threw: ${redact(err instanceof Error ? (err.stack ?? err.message) : String(err))}`);
} finally {
  for (const pid of workers()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
    check(false, `worker ${pid} was still running at the end (killed)`);
  }
  for (const child of owned) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  const started = [...logText().matchAll(/\] daemon started \(pid (\d+)\)/g)].map((m) => Number(m[1]));
  check(
    JSON.stringify(started) === JSON.stringify(startedDaemons),
    `daemon.log: "daemon started" once for each daemon, and only those (${started.join(", ")})`,
  );
  const counts = said.map((t) => delivered(t));
  check(counts.every((n) => n === 1), `every message reached the server once (${counts.join(", ")})`);
  const keyless = server.log.filter((x) => x.op.includes("no valid key")).length;
  check(keyless === 0, `no request came without a valid key (${keyless})`);
  const stubs = existsSync(STUB_LOG) ? readFileSync(STUB_LOG, "utf-8").split("\n").filter(Boolean) : [];
  check(!stubs.some((l) => l.startsWith("launchctl")), "launchctl was never run");
  console.log("\ndaemon.log, the lines about the lock:");
  for (const l of logText().split("\n").filter((l) => /exiting|daemon\.sock|taken over|daemon started|daemon stopped|shutting down/.test(l))) {
    console.log(`  ${redact(l)}`);
  }
  srv.close();
  rmSync(root, { recursive: true, force: true });
  console.log(`\n${failures ? `${failures} FAILED` : "all passed"}`);
  process.exit(failures ? 1 : 0);
}
