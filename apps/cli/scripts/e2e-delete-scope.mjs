#!/usr/bin/env node
/**
 * An opt-out the API key can't delete, under the real daemon from the built
 * CLI, against a fake Engram server on 127.0.0.1 that answers the way the
 * real one does (engram#597): a delete made with a key that lacks the
 * 'delete' permission is refused with a tool error whose text is the
 * `insufficient_scope` body (apps/mcp-server/src/mcp/scopes.ts). The unit
 * tests drive the syncer with fakes and fake time; this runs the worker
 * process, the CLI commands and daemon.db as they ship, and checks what
 * reaches the server and what the user is told:
 *
 *   - The refused delete is kept in daemon.db, never dropped, and not tried
 *     again with that key. daemon.log says so once; status.json and
 *     `engram status` say what to do. The sync health stays healthy, and
 *     other sessions keep syncing.
 *   - An opt-out made meanwhile waits with it, and sends nothing.
 *   - A restart tries once more, with one request.
 *   - Saving a key that can delete, with no restart, deletes them all and
 *     clears the warning.
 *
 * Usage, after `pnpm build`:  node scripts/e2e-delete-scope.mjs
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

// Made up on each run: they only exist on the fake server below. Both are
// the same account's; READ_ONLY can save but not delete.
const testKey = (name) => `engram_sk_live_e2e_${name}_${randomBytes(12).toString("hex")}`;
const KEYS = { READ_ONLY: testKey("ro"), CAN_DELETE: testKey("rw") };
const LABEL = new Map([[KEYS.READ_ONLY, "READ_ONLY"], [KEYS.CAN_DELETE, "CAN_DELETE"]]);
const fp = (k) => createHash("sha256").update(k).digest("hex");
const redact = (s) => s.replace(/engram_sk_live_e2e_\w*/g, "<test key>");

// What the real delete tool answers a key without the 'delete' permission
// (apps/mcp-server/src/mcp/scopes.ts), and what it answers for a
// conversation the account doesn't have.
const SCOPE_REFUSED = JSON.stringify({
  error: "insufficient_scope",
  required: "delete",
  message: "This API key does not have the 'delete' permission. Create a key with this scope at getengram.app/dashboard.",
});
const DELETE_NOT_FOUND = JSON.stringify({ error: "Conversation not found" });

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
  const key = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const label = key ? LABEL.get(key) : undefined;
  const record = (op, extra = {}) => server.log.push({ t: Date.now(), op, key: label ?? "none", ...extra });
  if (!label) {
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
    if (name === "delete_conversation") {
      const id = args.conversation_id;
      if (label === "READ_ONLY") {
        record("delete refused: scope", { conv: id });
        return send(res, 200, toolResult(rpc.id, SCOPE_REFUSED, true));
      }
      if (!server.conversations.has(id)) {
        record("delete refused: not found", { conv: id });
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
    const mine = new Set([fp(KEYS.READ_ONLY), fp(KEYS.CAN_DELETE)]);
    const owned = key_hashes.filter((h) => mine.has(h));
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
// On a server other than the default, the daemon keeps each delete under the
// key and the server together: the key's fingerprint, "@", then a tag of the
// server (engram#685). The owned-keys route still gets key fingerprints.
const SERVER_TAG = createHash("sha256").update(baseUrl).digest("hex").slice(0, 32);
const accountFp = (k) => `${fp(k)}@${SERVER_TAG}`;

// ── The temporary home, the stubs, the CLI ──────────────────────────────────
const root = mkdtempSync(join(tmpdir(), "engram-e2e-597-"));
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
      // Output to a pipe carries no escape codes (engram#628); say so if it does.
      const escapes = /\x1b\[/.test(out);
      out = redact(out.replace(/\x1b\[[0-9;]*m/g, ""));
      console.log(`\n$ engram ${redact(args.join(" "))}  (exit ${status})`);
      for (const line of out.trimEnd().split("\n")) console.log(`  │ ${line}`);
      resolve({ status, out, escapes });
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
const remoteDeletes = (keyFp) =>
  keyFp
    ? query("SELECT COUNT(*) AS n FROM remote_deletes WHERE key_fp = ?", keyFp).n
    : query("SELECT COUNT(*) AS n FROM remote_deletes").n;

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
const deletesOf = (conv, after = 0) => server.log.filter((x) => x.op.startsWith("delete") && x.conv === conv && x.t > after);
const deletesSince = (after = 0) => server.log.filter((x) => x.op.startsWith("delete") && x.t > after);
const said = (n) => `scope-e2e ${n}`;
const OPTED_OUT = (session) =>
  `[engram] session ${session} excluded (in-chat opt-out) — 0 queued messages dropped`;
const REFUSED = (conv, kept) =>
  `[engram] opt-out delete refused for ${conv}: this API key can't delete conversations. ` +
  `${kept} kept on this machine, waiting for a key that can; not retried with this one. ` +
  `Run 'engram status' for details.`;
const REFUSED_ANY = "[engram] opt-out delete refused for ";
const WAITS = "; the synced copy waits to be deleted: this API key can't delete conversations";
const WARNING = (n) =>
  `WARNING: This API key can't delete conversations, so ` +
  `${n === 1 ? "1 conversation you opted out of is" : `${n} conversations you opted out of are`} ` +
  `waiting to be deleted from Engram. Create a key with the 'delete' permission at ` +
  `getengram.app/dashboard, then run 'engram auth login <key>'.`;
const KEPT_NOTE = "Kept on this machine; not tried again with this key.";

try {
  // ── 1. signed in with a key that can save but not delete; capturing ──
  let r = await engram("auth", "login", KEYS.READ_ONLY);
  check(r.status === 0, "auth login (a key without 'delete') exits 0");
  let pid = await startWorker(null);
  const s1 = session();
  s1.say(said("s1 u1"));
  await waitFor("s1:u1 arrives", () => convWith(said("s1 u1")));
  const conv1 = convWith(said("s1 u1"));

  // ── 2. an opt-out: one delete, refused for scope; kept, and not tried again ──
  s1.say("engram:ignore");
  const first = await waitFor("s1's delete is sent", () => deletesOf(conv1)[0]);
  check(first?.op === "delete refused: scope", `it is refused for scope (${first?.op})`);
  await waitFor("daemon.log: refused, 1 kept", () => logCount(REFUSED(conv1, "1 opt-out delete")) === 1, 10_000);
  const tFirst = first?.t ?? Date.now();
  // Before engram#597 the delete was asked again within seconds, and again
  // and again, with a line in daemon.log each time.
  await sleep(15_000);
  check(deletesOf(conv1, tFirst).length === 0, `not tried again in 15 s (${deletesOf(conv1, tFirst).length} more)`);
  check(logCount(REFUSED_ANY) === 1, `daemon.log says it once (${logCount(REFUSED_ANY)})`);
  check(logCount(`${OPTED_OUT(s1.id)}, deleting synced copy`) === 1, "daemon.log: the opt-out line, as before");
  let st = syncStatus();
  check(
    st.delete_refused?.deletes === 1 && typeof st.delete_refused?.since === "string",
    `status.json: delete_refused, 1 waiting (${JSON.stringify(st.delete_refused)})`,
  );
  const since = st.delete_refused?.since;
  check(
    st.health === "healthy" && st.consecutive_failures === 0 && st.error_type === null,
    `status.json: healthy (${st.health}, ${st.consecutive_failures}, ${st.error_type})`,
  );
  check(remoteDeletes(accountFp(KEYS.READ_ONLY)) === 1, "the delete is kept in daemon.db");
  check(server.conversations.has(conv1), "and the conversation is still on the server");
  r = await engram("status");
  check(r.status === 0, "engram status exits 0");
  check(r.out.includes(WARNING(1)), "engram status: the warning, for 1, with what to do");
  check(r.out.includes(KEPT_NOTE), "engram status: kept, not tried again");
  check(r.out.includes(`Since: ${since}`), "engram status: since when");
  check(/Last sync:\s+\S/.test(r.out), "engram status: last sync still shown");
  check(r.out.includes("Plan: pro"), "engram status: the plan still shown");
  check(!r.escapes, "engram status: no escape codes through a pipe");

  // ── 3. syncing goes on; an opt-out made meanwhile waits too, with no request ──
  const s2 = session();
  s2.say(said("s2 v1"));
  await waitFor("s2:v1 arrives", () => convWith(said("s2 v1")));
  const conv2 = convWith(said("s2 v1"));
  const t3 = Date.now();
  s2.say("engram:ignore");
  await waitFor("daemon.log: s2's opt-out waits, and says why", () => logCount(`${OPTED_OUT(s2.id)}${WAITS}`) === 1, 10_000);
  await waitFor("status.json: 2 waiting", () => syncStatus().delete_refused?.deletes === 2, 10_000);
  await sleep(6_000);
  check(deletesSince(t3).length === 0, `no delete request for it (${deletesSince(t3).length})`);
  check(syncStatus().delete_refused?.since === since, "since is unchanged");
  check(remoteDeletes(accountFp(KEYS.READ_ONLY)) === 2, "both deletes are kept in daemon.db");
  const s3 = session();
  s3.say(said("s3 w1"));
  await waitFor("s3:w1 arrives", () => convWith(said("s3 w1")));
  check(logCount(REFUSED_ANY) === 1, `still said once (${logCount(REFUSED_ANY)})`);
  r = await engram("daemon", "status");
  check(r.status === 0, "daemon status exits 0");
  check(r.out.includes(WARNING(2)), "daemon status: the warning, for 2");

  // ── 4. a restart tries once more with this key: one request ──
  await stopWorker(pid);
  const tRestart = Date.now();
  pid = await startWorker(pid);
  await waitFor("after the restart, a delete is tried", () => deletesSince(tRestart).length >= 1);
  await waitFor("daemon.log: refused, said once for this run", () => logCount(REFUSED_ANY) === 2, 10_000);
  await sleep(8_000);
  const afterRestart = deletesSince(tRestart);
  check(
    afterRestart.length === 1 && afterRestart[0].op === "delete refused: scope" && afterRestart[0].conv === conv1,
    `one request, the oldest, refused (${afterRestart.map((x) => `${x.op} ${x.conv}`).join(", ")})`,
  );
  check(logCount(REFUSED(conv1, "2 opt-out deletes")) === 1, "daemon.log: 2 kept");
  st = syncStatus();
  check(st.delete_refused?.deletes === 2, `status.json after the restart: 2 waiting (${JSON.stringify(st.delete_refused)})`);
  check(remoteDeletes(accountFp(KEYS.READ_ONLY)) === 2, "both deletes are still kept in daemon.db");

  // ── 5. a key that can delete, with no restart: both go, the warning clears ──
  const tSwitch = Date.now();
  r = await engram("auth", "login", KEYS.CAN_DELETE);
  check(r.status === 0, "auth login (a key that can delete) exits 0");
  await waitFor("both conversations are deleted", () => !server.conversations.has(conv1) && !server.conversations.has(conv2));
  check(daemonPid() === pid && alive(pid), "the same worker: no restart");
  const switched = deletesSince(tSwitch);
  check(
    switched.length === 2 && switched.every((x) => x.op === "delete" && x.key === "CAN_DELETE"),
    `two deletes, with the new key (${switched.map((x) => `${x.op}/${x.key}`).join(", ")})`,
  );
  await waitFor("daemon.db: nothing kept", () => remoteDeletes() === 0, 10_000);
  await waitFor("status.json: delete_refused cleared", () => syncStatus().delete_refused === null, 10_000);
  r = await engram("status");
  check(r.status === 0, "engram status exits 0");
  check(!r.out.includes("WARNING") && !r.out.includes("can't delete"), "engram status: no warning");
  check(server.conversations.has(convWith(said("s3 w1"))), "s3's conversation is untouched");
  await sleep(4_000);
  check(deletesSince(tSwitch).length === 2, "nothing more is deleted");
  check(logCount(REFUSED_ANY) === 2, "no new refusal line");
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
  console.log("\ndaemon.log, the lines about opt-outs and deletes:");
  for (const l of logText().split("\n").filter((l) => /delete|opt-out|excluded/.test(l))) console.log(`  ${redact(l)}`);
  srv.close();
  rmSync(root, { recursive: true, force: true });
  console.log(`\n${failures ? `${failures} FAILED` : "all passed"}`);
  process.exit(failures ? 1 : 0);
}
