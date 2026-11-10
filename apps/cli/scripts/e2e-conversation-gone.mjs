#!/usr/bin/env node
/**
 * A conversation Engram no longer has, under the real daemon from the built
 * CLI, against a fake Engram server on 127.0.0.1 that answers the way the
 * real one does (engram#593): an append to a conversation it doesn't have is
 * refused with a tool error whose text is the `conversation_not_found` body
 * (engram#592). The unit tests drive the syncer with fakes and fake time;
 * this runs the worker process, the CLI commands and daemon.db as they ship,
 * and checks what reaches the server and what the user is told:
 *
 *   - The first such answer sets the conversation's messages aside: they are
 *     not sent again every few seconds, the session's conversation is not
 *     created again, and nothing is deleted. Later captures of the session
 *     are kept with them. Status says "Not sent"; the sync health stays
 *     healthy.
 *   - Other sessions keep syncing.
 *   - An in-chat opt-out of the session drops what was set aside.
 *   - The conversation is checked again, with one message, on a schedule kept
 *     in daemon.db across a restart. Once Engram has it again, the rest goes
 *     out, in order, into the same conversation.
 *
 * Usage, after `pnpm build`:  node scripts/e2e-conversation-gone.mjs
 *
 * The first recheck is due 10 minutes after the first answer, the next an
 * hour after the second: rather than wait, the test moves the time of the
 * last answer back in daemon.db.
 *
 * Everything happens under a temporary home with a made-up key, and the CLI
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

// Made up on each run: it only exists on the fake server below.
const KEY = `engram_sk_live_e2e_gone_${randomBytes(12).toString("hex")}`;
const KEY_FP = createHash("sha256").update(KEY).digest("hex");
const redact = (s) => s.replace(/engram_sk_live_e2e_\w*/g, "<test key>");
const MIN = 60_000;
const HOUR = 60 * MIN;

// What the real server answers an append to a conversation it doesn't have
// (apps/mcp-server: conversationNotFound(), passed through by the MCP tool
// guard), and what its delete tool answers for one.
const NOT_FOUND = JSON.stringify({
  error: "conversation_not_found",
  message: "No conversation with that id exists in this account.",
});
const DELETE_NOT_FOUND = JSON.stringify({ error: "Conversation not found" });

// ── The fake server ─────────────────────────────────────────────────────────
const server = {
  conversations: new Map(), // id -> { messages }
  removed: new Map(), // id -> { messages }: gone from the account, as a delete on the web does
  log: [], // { t, op, conv?, contents? }
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
/** The conversation leaves the account; what it held is kept for restore(). */
function remove(id) {
  server.removed.set(id, server.conversations.get(id));
  server.conversations.delete(id);
}
/** Engram has the conversation again, with what it held. */
function restore(id) {
  server.conversations.set(id, server.removed.get(id));
  server.removed.delete(id);
}

const srv = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const url = new URL(req.url ?? "/", "http://fake");
  const record = (op, extra = {}) => server.log.push({ t: Date.now(), op, ...extra });
  if (req.headers.authorization !== `Bearer ${KEY}`) {
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
        record("append refused", { conv: args.conversation_id, contents });
        return send(res, 200, toolResult(rpc.id, NOT_FOUND, true));
      }
      conv.messages.push(...contents);
      record("append", { conv: args.conversation_id, contents });
      return send(res, 200, toolResult(rpc.id, { appended: contents.length, message_ids: contents.map(() => `msg_${randomUUID()}`) }));
    }
    if (name === "delete_conversation") {
      const id = args.conversation_id;
      if (!server.conversations.has(id)) {
        record("delete refused", { conv: id });
        return send(res, 200, toolResult(rpc.id, DELETE_NOT_FOUND, true));
      }
      server.conversations.delete(id);
      record("delete", { conv: id });
      return send(res, 200, toolResult(rpc.id, { deleted: true }));
    }
    record(`tool ${name}`);
    return send(res, 200, toolResult(rpc.id, `unknown tool ${name}`, true));
  }
  if (req.method === "POST" && url.pathname === "/api/account/owned-keys") {
    const { key_hashes = [] } = JSON.parse(body || "{}");
    record("owned-keys");
    return send(res, 200, { owned: key_hashes.filter((h) => h === KEY_FP) });
  }
  if (req.method === "GET" && url.pathname === "/api/account") {
    record("account");
    return send(res, 200, {
      org_id: "org_e2e", email: "e2e@example.test", name: null, tier: "free", deleted_at: null, purge_at: null,
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
const baseUrl = `http://127.0.0.1:${srv.address().port}`;

// ── The temporary home, the stubs, the CLI ──────────────────────────────────
const root = mkdtempSync(join(tmpdir(), "engram-e2e-593-"));
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
const STATUS_FILE = join(ENGRAM_DIR, "status.json");
const DB_FILE = join(ENGRAM_DIR, "daemon.db");

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
const daemonPid = () => {
  try {
    const n = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    return Number.isNaN(n) ? null : n;
  } catch {
    return null;
  }
};
async function startWorker(not) {
  const r = await engram("start");
  check(r.status === 0, "start exits 0");
  const pid = await waitFor("the worker writes its PID file", () => {
    const p = daemonPid();
    return p && p !== not && alive(p) ? p : null;
  });
  if (pid) pids.add(pid);
  return pid;
}
async function stopWorker(pid) {
  const r = await engram("stop");
  check(r.status === 0, "stop exits 0");
  if (pid) await waitFor("the worker exits", () => !alive(pid));
}
const syncStatus = () => JSON.parse(readFileSync(STATUS_FILE, "utf-8"));

// daemon.db, read as the CLI's own status command does: read-only.
function query(sql, ...params) {
  const db = new Database(DB_FILE, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).get(...params);
  } finally {
    db.close();
  }
}
const unsentIn = (conv) =>
  query("SELECT COUNT(*) AS n FROM pending_messages WHERE sent_at IS NULL AND conversation_id = ?", conv).n;
const goneMark = (conv) =>
  query("SELECT checks, checked_at FROM gone_conversations WHERE conversation_id = ?", conv) ?? null;
const remoteDeletes = () => query("SELECT COUNT(*) AS n FROM remote_deletes").n;
/** Move the time of the latest answer about `conv` back by `ms`, as if that long had passed. */
function moveCheckBack(conv, ms) {
  const db = new Database(DB_FILE, { fileMustExist: true });
  try {
    return db.prepare("UPDATE gone_conversations SET checked_at = checked_at - ? WHERE conversation_id = ?").run(ms, conv).changes;
  } finally {
    db.close();
  }
}

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
const convWith = (text) => [...server.conversations].find(([, c]) => c.messages.some((m) => m.includes(text)))?.[0] ?? null;
const arrived = (text) => convWith(text) !== null;
const creates = () => server.log.filter((x) => x.op === "create").length;
const sendsTo = (conv, after) => server.log.filter((x) => x.conv === conv && x.op.startsWith("append") && x.t > after);
const said = (n) => `gone-e2e ${n}`;
const NOT_SENT_NOTE =
  "(their conversation is no longer on Engram — kept on this machine; nothing to do if you deleted it)";
const GONE = (conv, n, next) =>
  `[engram] conversation ${conv} isn't on Engram (deleted there, or not this account's) — ` +
  `keeping its ${n} on this machine, not sent; checking again in ${next}`;
const STILL_GONE = (conv, n, next) =>
  `[engram] conversation ${conv} still isn't on Engram (deleted there, or not this account's) — ` +
  `keeping its ${n} on this machine, not sent; checking again in ${next}`;

try {
  // ── 1. signed in, capturing ──
  let r = await engram("auth", "login", KEY);
  check(r.status === 0, "auth login exits 0");
  let pid = await startWorker(null);
  const s1 = session();
  s1.say(said("s1 u1"));
  await waitFor("s1:u1 arrives", () => arrived(said("s1 u1")));
  const conv1 = convWith(said("s1 u1"));

  // ── 2. Engram no longer has the conversation: one answer sets it aside ──
  remove(conv1);
  s1.say(said("s1 u2"));
  const refused = await waitFor("s1:u2's send is refused", () =>
    server.log.find((x) => x.op === "append refused" && x.conv === conv1));
  check(refused?.contents.length === 1 && refused.contents[0].includes(said("s1 u2")), "it carried s1:u2");
  const tRefused = refused?.t ?? Date.now();
  await sleep(15_000);
  const again = sendsTo(conv1, tRefused).length;
  check(again === 0, `it isn't sent again in 15 s (${again} send(s); it used to be every 2 s)`);
  check(creates() === 1, `the session's conversation isn't created again (${creates()} created)`);
  check(logCount(GONE(conv1, "1 queued message", "10 minutes")) === 1, "daemon.log says what happened, once");
  check(logCount("send failed") === 0, "and logs no failed send");
  let st = syncStatus();
  check(
    st.health === "healthy" && st.consecutive_failures === 0 && st.error_type === null && st.last_error === null,
    `status.json: healthy, no failure (${st.health}, ${st.consecutive_failures}, ${st.error_type})`,
  );
  check(st.pending_messages === 0 && st.next_retry_at === null, `status.json: nothing pending, no retry (${st.pending_messages})`);
  check(unsentIn(conv1) === 1, "s1:u2 is kept in daemon.db, unsent");
  check(goneMark(conv1)?.checks === 1, "its conversation is marked, after one answer");
  r = await engram("daemon", "status");
  check(r.out.includes(`Not sent:          1 message ${NOT_SENT_NOTE}`), "daemon status: Not sent: 1 message");
  check(/Pending sync:\s+0 messages/.test(r.out) && !r.out.includes("Held:"), "daemon status: nothing pending, nothing held");
  check(!/[Ee]rror|failing/.test(r.out), "daemon status: no error shown");
  r = await engram("status");
  check(r.out.includes(`Not sent:          1 message ${NOT_SENT_NOTE}`), "engram status says it too");

  // ── 3. later captures of the session are kept with it ──
  const t3 = Date.now();
  s1.say(said("s1 u3"));
  await waitFor("s1:u3 is queued with it", () => unsentIn(conv1) === 2);
  await sleep(5_000);
  check(sendsTo(conv1, t3).length === 0, "s1:u3 isn't sent");
  check(creates() === 1, `no conversation is created for it (${creates()} created)`);

  // ── 4. other sessions keep syncing ──
  const s2 = session();
  s2.say(said("s2 v1"));
  await waitFor("s2:v1 arrives", () => arrived(said("s2 v1")));
  check(convWith(said("s2 v1")) !== conv1, "in a conversation of its own");

  // ── 5. an in-chat opt-out of a session drops what was set aside ──
  const s3 = session();
  s3.say(said("s3 w1"));
  await waitFor("s3:w1 arrives", () => arrived(said("s3 w1")));
  const conv3 = convWith(said("s3 w1"));
  remove(conv3);
  s3.say(said("s3 w2"));
  await waitFor("s3:w2 is set aside", () => goneMark(conv3)?.checks === 1 && unsentIn(conv3) === 1);
  r = await engram("daemon", "status");
  check(r.out.includes(`Not sent:          3 messages ${NOT_SENT_NOTE}`), "daemon status: Not sent: 3 messages");
  s3.say("engram:ignore");
  await waitFor("the opt-out drops s3:w2 and the mark", () => unsentIn(conv3) === 0 && goneMark(conv3) === null);
  await waitFor("its delete is sent, and Engram's answer that it has no such conversation counts as done", () =>
    server.log.some((x) => x.op === "delete refused" && x.conv === conv3) && remoteDeletes() === 0);
  check(logCount(`[engram] session ${s3.id} excluded (in-chat opt-out) — 1 queued message dropped`) === 1, "daemon.log: 1 queued message dropped");
  r = await engram("daemon", "status");
  check(r.out.includes(`Not sent:          2 messages ${NOT_SENT_NOTE}`), "daemon status: Not sent: 2 messages (s1's)");

  // ── 6. checked again on the schedule in daemon.db, across a restart ──
  await stopWorker(pid);
  check(moveCheckBack(conv1, 10 * MIN + 30_000) === 1, "(the last answer is moved back 10.5 minutes)");
  const tRestart = Date.now();
  pid = await startWorker(pid);
  const recheck = await waitFor("after the restart, the conversation is checked again", () =>
    sendsTo(conv1, tRestart)[0]);
  check(
    recheck?.op === "append refused" && recheck.contents.length === 1 && recheck.contents[0].includes(said("s1 u2")),
    "with one message, the oldest (s1:u2)",
  );
  await waitFor("daemon.log: still isn't, checking again in 1 hour", () =>
    logCount(STILL_GONE(conv1, "2 queued messages", "1 hour")) === 1);
  check(goneMark(conv1)?.checks === 2, "its mark counts two answers");
  const tRecheck = recheck?.t ?? Date.now();
  await sleep(6_000);
  check(sendsTo(conv1, tRecheck).length === 0, "and it isn't sent again after that");
  check(creates() === 3, `nothing is created (${creates()} created: one per session)`);

  // ── 7. Engram has it again: the rest goes out, in order, to the same conversation ──
  restore(conv1);
  check(moveCheckBack(conv1, HOUR + 30_000) === 1, "(the last answer is moved back an hour)");
  await waitFor("s1:u3 arrives", () => server.conversations.get(conv1)?.messages.some((m) => m.includes(said("s1 u3"))));
  const sends = sendsTo(conv1, tRecheck);
  check(
    sends.length === 2 && sends.every((x) => x.op === "append") && sends[0].contents.length === 1 && sends[1].contents.length === 1,
    `checked with one message, then the rest (${sends.map((x) => `${x.op} ${x.contents.length}`).join(", ")})`,
  );
  check(logCount(`[engram] conversation ${conv1} is on Engram again — sending its queued messages`) === 1, "daemon.log: on Engram again");
  check(goneMark(conv1) === null && unsentIn(conv1) === 0, "the mark is cleared and nothing is left unsent");
  r = await engram("daemon", "status");
  check(!r.out.includes("Not sent:") && /Pending sync:\s+0 messages/.test(r.out), "daemon status: no Not sent line");
  s1.say(said("s1 u4"));
  await waitFor("s1:u4 arrives", () => server.conversations.get(conv1)?.messages.some((m) => m.includes(said("s1 u4"))));
  st = syncStatus();
  check(st.health === "healthy" && st.consecutive_failures === 0, "status.json: healthy");
  await stopWorker(pid);
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
  // Every message is in its conversation exactly once, in the order said.
  const inOrder = (conv, prefix) =>
    (server.conversations.get(conv)?.messages ?? []).map((m) => new RegExp(`${prefix} (\\w+)`).exec(m)?.[1] ?? "?");
  const s1Conv = [...server.conversations].find(([, c]) => c.messages.some((m) => m.includes(said("s1 u1"))))?.[0];
  const got = s1Conv ? inOrder(s1Conv, said("s1")) : [];
  check(JSON.stringify(got) === JSON.stringify(["u1", "u2", "u3", "u4"]), `s1's conversation holds u1, u2, u3, u4, once each, in order (${got.join(", ")})`);
  const elsewhere = [...server.conversations].filter(([id]) => id !== s1Conv).flatMap(([, c]) => c.messages).filter((m) => m.includes(said("s1")));
  check(elsewhere.length === 0, `no s1 message is in another conversation (${elsewhere.length})`);
  const keyless = server.log.filter((x) => x.op.includes("no valid key")).length;
  check(keyless === 0, `no request came without a valid key (${keyless})`);
  const stubs = existsSync(STUB_LOG) ? readFileSync(STUB_LOG, "utf-8").split("\n").filter(Boolean) : [];
  // launchctl only looked for the job a sudo install could have loaded into
  // launchd's system domain, which changes nothing (engram#680).
  const launchctl = stubs.filter((l) => l.startsWith("launchctl") && l !== "launchctl print system/app.getengram.daemon");
  check(launchctl.length === 0, `launchctl was run only to look in launchd's system domain${launchctl.length ? ` (also: ${launchctl.join("; ")})` : ""}`);
  const ops = {};
  for (const x of server.log) ops[x.op] = (ops[x.op] ?? 0) + 1;
  console.log("\nrequests the server saw:", JSON.stringify(ops, null, 1));
  srv.close();
  rmSync(root, { recursive: true, force: true });
  console.log(`\n${failures ? `${failures} FAILED` : "all passed"}`);
  process.exit(failures ? 1 : 0);
}
