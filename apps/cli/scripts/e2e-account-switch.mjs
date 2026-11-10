#!/usr/bin/env node
/**
 * Signs in, out and between accounts under the real daemon from the built
 * CLI, against a fake Engram server on 127.0.0.1 (engram#594, #595, #625).
 * The unit tests drive the syncer with fakes; this runs the worker process,
 * the CLI commands and daemon.db as they ship, and checks what reaches the
 * server:
 *
 *   - `engram auth login` checks a key at the configured server (#625).
 *   - `engram auth logout` stops sending within seconds, even while a send
 *     hangs, with nothing deleted: what's queued stays in daemon.db.
 *   - A new key is picked up without a restart. What was queued under one
 *     account's key is never sent with another account's, and goes out
 *     with a later key of the same account, into the same conversation.
 *   - With no key, `engram start` runs a worker that waits, logging once,
 *     and starts capturing when `engram auth login` saves a key (#595).
 *
 * Usage, after `pnpm build`:  node scripts/e2e-account-switch.mjs
 *
 * Everything happens under a temporary home with made-up keys, and the CLI
 * runs with an environment of its own (no ENGRAM_API_KEY from your shell),
 * so it never touches your ~/.engram or your account. launchctl, osascript
 * and notify-send are stubs on its PATH. POSIX only: on Windows it skips.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  console.log("skipped: the stubs and paths here are POSIX-only");
  process.exit(0);
}

const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));
if (!existsSync(CLI)) {
  console.error(`no build at ${CLI}: run 'pnpm build' first`);
  process.exit(2);
}
const Database = createRequire(import.meta.url)("better-sqlite3");
const node = process.execPath;

// Made up on each run: they only exist on the fake server below.
const testKey = (name) => `engram_sk_live_e2e_${name}_${randomBytes(12).toString("hex")}`;
const KEYS = { A1: testKey("a1"), A2: testKey("a2"), B: testKey("b") };
const ACCOUNT_OF = new Map([[KEYS.A1, "A"], [KEYS.A2, "A"], [KEYS.B, "B"]]);
const LABEL = new Map([[KEYS.A1, "A1"], [KEYS.A2, "A2"], [KEYS.B, "B"]]);
const fp = (k) => createHash("sha256").update(k).digest("hex");
const redact = (s) => s.replace(/engram_sk_live_e2e_\w*/g, "<test key>");

// ── The fake server ─────────────────────────────────────────────────────────
// Accounts A (keys A1 and A2) and B (key B). Every message written here
// names the account it was written for ("acct-A …"), so a message sent with
// the other account's key is caught, as is a write to the other account's
// conversation.
const server = {
  conversations: new Map(), // id -> { account, messages }
  log: [], // { t, op, key, account, ... }
  violations: [],
  holdAppends: false, // leave sends unanswered, as a server that hangs does
  held: [],
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
const accountNamedIn = (content) =>
  /acct-([AB])\b/.exec(typeof content === "string" ? content : JSON.stringify(content))?.[1];

const srv = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const url = new URL(req.url ?? "/", "http://fake");
  const auth = req.headers.authorization ?? "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const account = key ? ACCOUNT_OF.get(key) : undefined;
  const record = (op, extra = {}) =>
    server.log.push({ t: Date.now(), op, key: key ? (LABEL.get(key) ?? "unknown") : "none", account: account ?? null, ...extra });

  // Email + password sign-in, which takes no key. Account A already has
  // keys, so it gets the "limit reached" answer that makes `engram login`
  // fall back to the saved key.
  if (req.method === "POST" && url.pathname === "/signup/login") {
    const { email } = JSON.parse(body || "{}");
    record("signup/login");
    if (email === "a@example.test") {
      return send(res, 409, {
        error: "api_key_limit_reached",
        message: "This account already has the maximum number of API keys.",
        organization_id: "org_A",
      });
    }
    return send(res, 404, { error: "not_found", message: "No account with that email." });
  }

  if (!account) {
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
      server.conversations.set(id, { account, messages: [] });
      record("create", { conv: id });
      return send(res, 200, toolResult(rpc.id, { conversation_id: id }));
    }
    if (name === "append_messages") {
      const contents = (args.messages ?? []).map((m) => m.content);
      if (server.holdAppends) {
        record("append held", { conv: args.conversation_id, contents });
        server.held.push({ res, id: rpc.id });
        return;
      }
      const conv = server.conversations.get(args.conversation_id);
      if (conv && conv.account !== account) {
        server.violations.push(`append with an account-${account} key to an account-${conv.account} conversation`);
      }
      for (const c of contents) {
        const named = accountNamedIn(c);
        if (named && named !== account) server.violations.push(`an account-${named} message sent with an account-${account} key`);
      }
      if (!conv || conv.account !== account) {
        record("append refused: no such conversation", { conv: args.conversation_id });
        return send(res, 200, toolResult(rpc.id, "Conversation not found", true));
      }
      conv.messages.push(...contents);
      record("append", { conv: args.conversation_id, contents });
      return send(res, 200, toolResult(rpc.id, { appended: contents.length, message_ids: contents.map(() => `msg_${randomUUID()}`) }));
    }
    if (name === "delete_conversation") {
      const conv = server.conversations.get(args.conversation_id);
      if (conv && conv.account !== account) server.violations.push(`delete with an account-${account} key of an account-${conv.account} conversation`);
      if (!conv || conv.account !== account) {
        record("delete refused: no such conversation", { conv: args.conversation_id });
        return send(res, 200, toolResult(rpc.id, "Conversation not found", true));
      }
      server.conversations.delete(args.conversation_id);
      record("delete", { conv: args.conversation_id });
      return send(res, 200, toolResult(rpc.id, { deleted: true }));
    }
    record(`tool ${name}`);
    return send(res, 200, toolResult(rpc.id, `unknown tool ${name}`, true));
  }
  // Which of the asked-about key fingerprints are the caller's account's.
  if (req.method === "POST" && url.pathname === "/api/account/owned-keys") {
    const { key_hashes = [] } = JSON.parse(body || "{}");
    const mine = new Set([...ACCOUNT_OF].filter(([, a]) => a === account).map(([k]) => fp(k)));
    const owned = key_hashes.filter((h) => mine.has(h));
    record("owned-keys", { asked: key_hashes.length, owned: owned.length });
    return send(res, 200, { owned });
  }
  if (req.method === "GET" && url.pathname === "/api/account") {
    record("account");
    return send(res, 200, {
      org_id: `org_${account}`, email: `${account.toLowerCase()}@example.test`, name: null, tier: "free", deleted_at: null, purge_at: null,
    });
  }
  if (req.method === "GET" && url.pathname === "/api/usage") {
    record("usage");
    return send(res, 200, {});
  }
  record(`${req.method} ${url.pathname} 404`);
  return send(res, 404, { error: "not_found" });
});
await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
/** Answer the sends left hanging with a 503: what they carried stays queued. */
function releaseHeld() {
  server.holdAppends = false;
  for (const { res, id } of server.held.splice(0)) {
    send(res, 503, { jsonrpc: "2.0", id, error: { code: -32000, message: "Service temporarily unavailable" } });
  }
}
const baseUrl = `http://127.0.0.1:${srv.address().port}`;
// On a server other than the default, the daemon queues each message under
// the key and the server together: the key's fingerprint, "@", then a tag of
// the server (engram#685). The owned-keys route still gets key fingerprints.
const SERVER_TAG = createHash("sha256").update(baseUrl).digest("hex").slice(0, 32);
const accountFp = (k) => `${fp(k)}@${SERVER_TAG}`;

// ── The temporary home, the stubs, the CLI ──────────────────────────────────
const root = mkdtempSync(join(tmpdir(), "engram-e2e-594-"));
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
  // No ENGRAM_API_KEY: the daemon would use it for its whole life, and
  // following config.json is what's tested.
};
const ENGRAM_DIR = join(home, ".engram");
const LOG_FILE = join(ENGRAM_DIR, "daemon.log");
const PID_FILE = join(ENGRAM_DIR, "daemon.pid");
const CONFIG = join(ENGRAM_DIR, "config.json");

const pids = new Set();
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
process.on("SIGINT", () => {
  for (const p of pids) if (alive(p)) process.kill(p, "SIGKILL");
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
async function waitFor(what, test, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = test();
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

const logText = () => (existsSync(LOG_FILE) ? readFileSync(LOG_FILE, "utf-8") : "");
const logCount = (s) => logText().split("\n").filter((l) => l.includes(s)).length;
const SIGNED_IN = "[engram] signed in";
const SIGNED_OUT = "[engram] signed out";
const NEW_KEY = "[engram] new API key found";
const daemonPid = () => {
  try {
    const n = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    return Number.isNaN(n) ? null : n;
  } catch {
    return null;
  }
};
const savedKey = () => {
  try {
    return JSON.parse(readFileSync(CONFIG, "utf-8")).apiKey ?? null;
  } catch {
    return null;
  }
};
/** Unsent rows in daemon.db queued under `key` on this server. */
function queuedUnder(key) {
  const db = new Database(join(ENGRAM_DIR, "daemon.db"), { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT COUNT(*) AS n FROM pending_messages WHERE sent_at IS NULL AND key_fp = ?").get(accountFp(key)).n;
  } finally {
    db.close();
  }
}
// One Claude Code session, written to as the test goes.
const SESSION = randomUUID();
const transcript = join(project, `${SESSION}.jsonl`);
const say = (text) =>
  appendFileSync(
    transcript,
    JSON.stringify({ type: "user", sessionId: SESSION, cwd: "/work/proj", message: { role: "user", content: text } }) + "\n",
  );
const convsOf = (account) => [...server.conversations].filter(([, c]) => c.account === account);
const arrived = (account, text) => convsOf(account).some(([, c]) => c.messages.some((m) => String(m).includes(text)));
const keyedRequestsSince = (t) => server.log.filter((r) => r.t >= t && r.key !== "none");
const creates = (account) => server.log.filter((r) => r.op === "create" && r.account === account).length;

try {
  // ── 1. auth login checks the key where it will be used (#625) ──
  let r = await engram("auth", "login", KEYS.A1);
  check(r.status === 0, "auth login A1 exits 0");
  check(server.log.some((x) => x.op === "list" && x.key === "A1"), "auth login checked the key at ENGRAM_BASE_URL (#625)");
  check(savedKey() === KEYS.A1, "the key is saved");
  r = await engram("start");
  check(r.status === 0, "start exits 0");
  const pid = await waitFor("the worker writes its PID file", () => {
    const p = daemonPid();
    return p && alive(p) ? p : null;
  });
  if (pid) pids.add(pid);
  check(!existsSync(join(home, "Library")), "nothing is written for launchd");
  say("acct-A u1");
  await waitFor("A:u1 arrives in account A", () => arrived("A", "acct-A u1"));
  const convA = convsOf("A")[0]?.[0];

  // ── 2. logout stops sending at once, even with a send stuck; what's queued stays (#594) ──
  // While a send hangs, the daemon's own timer is all that reads the key.
  server.holdAppends = true;
  say("acct-A u2");
  await waitFor("A:u2's send is under way, and hangs", () =>
    server.log.some((x) => x.op === "append held" && x.contents.some((c) => String(c).includes("acct-A u2"))));
  const out0 = logCount(SIGNED_OUT);
  r = await engram("auth", "logout");
  check(r.status === 0, "auth logout exits 0");
  const tLogout = Date.now();
  const noticed = await waitFor("the daemon notices the logout", () => logCount(SIGNED_OUT) > out0, 10_000);
  const tNoticed = Date.now();
  if (noticed) console.log(`      (noticed ${((tNoticed - tLogout) / 1000).toFixed(1)}s after the logout)`);
  check(Boolean(noticed) && tNoticed - tLogout <= 5_000, "the logout is noticed within 5 s, with a send stuck");
  releaseHeld(); // the stuck send fails, and the server is fine from here on: only the logout stops a send now
  await sleep(6_000);
  let since = keyedRequestsSince(tNoticed + 300);
  check(since.length === 0, `nothing is sent while signed out (${since.length} request(s) in 6 s)`);
  check(queuedUnder(KEYS.A1) === 1, `A:u2 stays queued on this machine under A1 (${queuedUnder(KEYS.A1)} row(s))`);
  check(!arrived("A", "acct-A u2"), "A:u2 was not sent");
  check(daemonPid() === pid && alive(pid), "the worker is still running");
  r = await engram("daemon", "status");
  check(/Signed out — capture is paused/.test(r.out) && /paused \(signed out\)/.test(r.out), "daemon status: signed out");
  check(/Held:\s+1 /.test(r.out), "daemon status: one message held");

  // ── 3. another account's key: picked up without a restart; A's queue held ──
  say("acct-B w1"); // written while signed out: the next account to sign in captures it
  await sleep(3_000);
  since = keyedRequestsSince(tNoticed + 300);
  check(since.length === 0, `still nothing sent after a line is written while signed out (${since.length})`);
  const in0 = logCount(SIGNED_IN);
  r = await engram("auth", "login", KEYS.B);
  check(r.status === 0, "auth login B exits 0");
  await waitFor("the daemon signs in with B", () => logCount(SIGNED_IN) > in0, 10_000);
  check(daemonPid() === pid && alive(pid), "same worker: no restart");
  await waitFor("B:w1 (written while signed out) arrives in account B", () => arrived("B", "acct-B w1"));
  say("acct-B u3");
  await waitFor("B:u3 arrives in account B", () => arrived("B", "acct-B u3"));
  check(!arrived("A", "acct-A u2") && !arrived("B", "acct-A u2"), "A:u2 is not sent with B's key");
  check(queuedUnder(KEYS.A1) === 1, "A:u2 is still queued under A1");
  const askedB = server.log.filter((x) => x.op === "owned-keys" && x.account === "B");
  check(askedB.length >= 1 && askedB.every((x) => x.owned === 0), "B was asked about A1 and doesn't own it");
  // `engram login` as A while B's key is saved: refused, nothing changed (#594).
  r = await engram("login", "--email", "a@example.test", "--password", "e2e-not-a-password");
  check(r.status === 1, "engram login as A exits 1 while B's key is saved");
  check(/belongs to another account \(b@example\.test\)/.test(r.out), "and says the saved key is another account's");
  check(savedKey() === KEYS.B, "config.json still holds B's key");

  // ── 4. a new key of account A: A1's queue goes out, to the same conversation ──
  const new0 = logCount(NEW_KEY);
  r = await engram("auth", "login", KEYS.A2);
  check(r.status === 0, "auth login A2 exits 0");
  await waitFor("the daemon picks up A2", () => logCount(NEW_KEY) > new0, 10_000);
  await waitFor("A:u2 arrives in account A", () => arrived("A", "acct-A u2"));
  check(Boolean(server.conversations.get(convA)?.messages.some((m) => String(m).includes("acct-A u2"))), "in A:u1's conversation");
  say("acct-A u4");
  await waitFor("A:u4 arrives in account A", () => arrived("A", "acct-A u4"));
  check(creates("A") === 1, `account A has one conversation for the session (${creates("A")} created)`);
  check(queuedUnder(KEYS.A1) === 0 && queuedUnder(KEYS.A2) === 0, "nothing is left queued for account A");

  // ── 5. #595: started with no key, the worker waits, then signs in ──
  const out1 = logCount(SIGNED_OUT);
  await engram("auth", "logout");
  await waitFor("signed out again", () => logCount(SIGNED_OUT) > out1, 10_000);
  r = await engram("stop");
  check(r.status === 0, "stop exits 0");
  if (pid) await waitFor("the worker exits", () => !alive(pid));
  const out2 = logCount(SIGNED_OUT);
  r = await engram("start");
  check(r.status === 0, "start with no key exits 0");
  const pid2 = await waitFor("a worker starts with no key", () => {
    const p = daemonPid();
    return p && p !== pid && alive(p) ? p : null;
  });
  if (pid2) pids.add(pid2);
  const tStart = Date.now();
  await sleep(10_000);
  check(pid2 !== null && alive(pid2) && daemonPid() === pid2, "10 s later the same worker is running: no exit, no restart loop");
  check(logCount(SIGNED_OUT) - out2 === 1, `it said it's signed out once, not on every check (${logCount(SIGNED_OUT) - out2})`);
  check(keyedRequestsSince(tStart).length === 0, "nothing is sent with no key");
  const in1 = logCount(SIGNED_IN);
  r = await engram("auth", "login", KEYS.A1);
  const tLogin = Date.now();
  if (await waitFor("capture starts once auth login saves a key", () => logCount(SIGNED_IN) > in1, 10_000)) {
    console.log(`      (signed in ${((Date.now() - tLogin) / 1000).toFixed(1)}s after auth login)`);
  }
  check(daemonPid() === pid2 && alive(pid2), "same worker: no restart");
  say("acct-A u5");
  await waitFor("A:u5 arrives in account A", () => arrived("A", "acct-A u5"));
  check(creates("A") === 1, `still one conversation in account A (${creates("A")} created)`);

  // ── 6. status, stop ──
  r = await engram("daemon", "status");
  check(/Status:\s+running/.test(r.out) && /Claude Code\s+capturing/.test(r.out), "daemon status: running and capturing");
  r = await engram("stop");
  check(r.status === 0, "stop exits 0");
  if (pid2) await waitFor("the worker exits", () => !alive(pid2));
} catch (err) {
  check(false, `threw: ${redact(err instanceof Error ? (err.stack ?? err.message) : String(err))}`);
} finally {
  for (const p of pids) {
    if (alive(p)) {
      try {
        process.kill(p, "SIGKILL");
      } catch {}
      check(false, `worker ${p} was still running at the end (killed)`);
    }
  }
  // Every message arrived once, in its own account.
  const expected = { A: ["acct-A u1", "acct-A u2", "acct-A u4", "acct-A u5"], B: ["acct-B w1", "acct-B u3"] };
  for (const [account, texts] of Object.entries(expected)) {
    const got = convsOf(account).flatMap(([, c]) => c.messages.map(String));
    for (const t of texts) {
      const n = got.filter((m) => m.includes(t)).length;
      check(n === 1, `"${t}" is in account ${account} exactly once (${n})`);
    }
  }
  check(server.violations.length === 0, `nothing crossed accounts${server.violations.length ? `: ${server.violations.join("; ")}` : ""}`);
  const keyless = server.log.filter((x) => x.op.includes("no valid key")).length;
  check(keyless === 0, `no request came without a valid key (${keyless})`);
  const stubs = existsSync(STUB_LOG) ? readFileSync(STUB_LOG, "utf-8").split("\n").filter(Boolean) : [];
  // launchctl only looked for the job a sudo install could have loaded into
  // launchd's system domain, which changes nothing (engram#680).
  const launchctl = stubs.filter((l) => l.startsWith("launchctl") && l !== "launchctl print system/app.getengram.daemon");
  check(launchctl.length === 0, `launchctl was run only to look in launchd's system domain${launchctl.length ? ` (also: ${launchctl.join("; ")})` : ""}`);
  const ops = {};
  for (const x of server.log) ops[`${x.op} [${x.key}]`] = (ops[`${x.op} [${x.key}]`] ?? 0) + 1;
  console.log("\nrequests the server saw:", JSON.stringify(ops, null, 1));
  releaseHeld();
  srv.close();
  rmSync(root, { recursive: true, force: true });
  console.log(`\n${failures ? `${failures} FAILED` : "all passed"}`);
  process.exit(failures ? 1 : 0);
}
