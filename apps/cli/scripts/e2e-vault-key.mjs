#!/usr/bin/env node
/**
 * A vault key that can't be read, under the real daemon from the built CLI,
 * against a fake Engram server on 127.0.0.1 that answers the way the real
 * one does (engram#677). The unit tests drive the scrubber and the syncer
 * with fakes and fake time; this runs the worker process, the CLI commands
 * and daemon.db as they ship, with a vault secret the CLI encrypted, and
 * checks what reaches the server and what the user is told:
 *
 *   - A folder where ~/.engram/vault-key was: the commands that need the key
 *     refuse, say why and what to do, and send nothing.
 *   - The daemon captures, and creates the conversation, which carries none
 *     of what was said, but holds every message in daemon.db, and says why
 *     in daemon.log, status.json, a desktop notification and `engram
 *     status`. The vault isn't read meanwhile.
 *   - The key put back, with no restart: the daemon reads it, then the
 *     vault, then sends all it held, with the vault's secret and the key
 *     itself scrubbed out. daemon.db keeps no copy of either.
 *   - A key the user can't read (mode 000; skipped as root): held over a
 *     restart, then sent scrubbed.
 *   - A key that isn't there any more, after one that couldn't be read:
 *     still held, and `engram status` says how to go on without one. A
 *     start with no key sends what was held. Nothing said is lost.
 *
 * Usage, after `pnpm build`:  node scripts/e2e-vault-key.mjs
 *
 * Everything happens under a temporary home with a made-up API key, vault
 * key and secret, and the CLI runs with an environment of its own (no
 * ENGRAM_API_KEY or ENGRAM_VAULT_KEY from your shell), so it never touches
 * your ~/.engram, your vault or your account. launchctl, osascript and
 * notify-send are stubs on its PATH. POSIX only: on Windows it skips.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, rmSync,
  writeFileSync,
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
// Mode 000 doesn't stop root reading a file.
const asRoot = process.getuid?.() === 0;

// Made up on each run: the API key only exists on the fake server below. The
// secret is a passphrase, with no shape a pattern could match: only the
// vault's exact value can scrub it.
const KEY = `engram_sk_live_e2e_vault_${randomBytes(12).toString("hex")}`;
const SECRET_NAME = "DOOR_CODE";
const SECRET = `plum-harbor-${randomBytes(4).toString("hex")}-lantern`;
const TOKEN = `[VAULT:${SECRET_NAME}]`;
const KEY_TOKEN = "[VAULT:vault-key]";
const fp = (k) => createHash("sha256").update(k).digest("hex");

// ── The fake server ─────────────────────────────────────────────────────────
const server = {
  conversations: new Map(), // id -> { messages }
  vault: new Map(), // name -> what vault_set stored: ciphertext, never the value
  log: [], // { t, op, key, conv?, name?, contents?, args? }
  bodies: [], // every request body as it came, to look for what must never come
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
  server.bodies.push(body);
  const url = new URL(req.url ?? "/", "http://fake");
  const auth = req.headers.authorization ?? "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const record = (op, extra = {}) => server.log.push({ t: Date.now(), op, key: key === KEY ? "KEY" : "none", ...extra });
  if (key !== KEY) {
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
      record("create", { conv: id, args });
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
    // The vault tools as apps/mcp-server/src/mcp/tools/vault-*.ts answer.
    if (name === "vault_set") {
      const now = new Date().toISOString();
      const was = server.vault.get(args.name);
      server.vault.set(args.name, {
        encrypted_value: args.encrypted_value,
        iv: args.iv,
        secret_type: args.secret_type,
        created_at: was?.created_at ?? now,
        updated_at: now,
      });
      record("vault_set", { name: args.name });
      return send(res, 200, toolResult(rpc.id, { stored: true, name: args.name, secret_type: args.secret_type }));
    }
    if (name === "vault_list") {
      record("vault_list");
      const secrets = [...server.vault].map(([n, s]) => ({
        name: n, secret_type: s.secret_type, created_at: s.created_at, updated_at: s.updated_at,
      }));
      return send(res, 200, toolResult(rpc.id, { secrets, total: secrets.length }));
    }
    if (name === "vault_get") {
      const s = server.vault.get(args.name);
      record("vault_get", { name: args.name });
      return send(res, 200, toolResult(rpc.id, s ? { name: args.name, ...s } : { error: `Secret "${args.name}" not found` }));
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
const root = mkdtempSync(join(tmpdir(), "engram-e2e-677-"));
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
const KEY_FILE = join(ENGRAM_DIR, "vault-key");
// Where the key waits while something else is in its place.
const KEY_ASIDE = join(root, "vault-key.aside");

// The vault key `engram vault keygen --save` made, once it has.
let vaultKey = null;
function knownVaultKey() {
  if (vaultKey) return vaultKey;
  try {
    vaultKey = readFileSync(KEY_FILE, "utf-8").trim() || null;
  } catch {}
  return vaultKey;
}
function redact(s) {
  let out = s.replace(/engram_sk_live_e2e_\w*/g, "<test key>").split(SECRET).join("<the secret>");
  const vk = knownVaultKey();
  // keygen prints the key's first 8 characters.
  if (vk) out = out.split(vk).join("<vault key>").split(vk.slice(0, 8)).join("<vault key>");
  return out;
}

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

/** What the last command said. */
let lastOut = "";

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
      lastOut = out;
      console.log(`\n$ engram ${redact(args.join(" "))}  (exit ${status})`);
      for (const line of out.trimEnd().split("\n")) console.log(`  │ ${line}`);
      resolve({ status, out });
    });
  });
}

const logText = () => (existsSync(LOG_FILE) ? readFileSync(LOG_FILE, "utf-8") : "");
const logCount = (s) => logText().split("\n").filter((l) => l.includes(s)).length;
const stubLines = () => (existsSync(STUB_LOG) ? readFileSync(STUB_LOG, "utf-8").split("\n").filter(Boolean) : []);
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
// {} until the daemon has written it.
const syncStatus = () => {
  try {
    return JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
  } catch {
    return {};
  }
};

// daemon.db, read as the CLI's own status command does: read-only. null
// until the daemon has made it.
function count(sql, ...params) {
  try {
    const db = new Database(DB_FILE, { readonly: true, fileMustExist: true });
    try {
      return db.prepare(sql).get(...params).n;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
const unsent = () => count("SELECT COUNT(*) AS n FROM pending_messages WHERE sent_at IS NULL");
/** The rows in daemon.db, sent or not, that hold `text`. */
const kept = (text) => count("SELECT COUNT(*) AS n FROM pending_messages WHERE instr(content, ?) > 0", text);

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
const since = (prefix, after) => server.log.filter((x) => x.op.startsWith(prefix) && x.t >= after);
const appended = (after = 0) => since("append", after).filter((x) => x.op === "append").flatMap((x) => x.contents);
/** What arrived of the message tagged `n`, each time it did. */
const said = (n) => `vault-e2e ${n}:`;
const arrived = (n) => appended().filter((c) => c.includes(said(n)));
/** The requests that carried `text`. */
const reached = (text) => server.bodies.filter((b) => b.includes(text)).length;

const FOLDER = "~/.engram/vault-key is a folder, not a file";
const DENIED = "~/.engram/vault-key can't be read: permission denied";
const GONE = "~/.engram/vault-key isn't there any more";
const FOLDER_FIX = "Move the folder aside, and put your vault key back in ~/.engram/vault-key.";
const DENIED_FIX = "Make it readable with: chmod 600 ~/.engram/vault-key";
const GONE_FIX =
  "If you don't use the vault, run 'engram stop', then 'engram start': the daemon starts without a key, " +
  "and sends what it held.";
const REFUSED = (problem) => `Error: ${problem}, so Engram can't use your vault key. Nothing was sent.`;
const HOLDING = (problem, fix) =>
  `vault scrubber: holding sends — ${problem}. Capture goes on, and what it captures is sent once the key ` +
  `can be read. ${fix}`;
const STILL = (problem) => `vault scrubber: still holding sends — ${problem}`;
const HELD = (problem) =>
  "[engram] holding queued messages until the vault key can be read, so a vault secret in them can't be " +
  `sent unredacted: ${problem}`;
const READ_NOW = "vault scrubber: the vault key can be read now — reading the vault before sending what was held";
const SENDING = "[engram] vault read — sending the messages held for it";
const SCRUB_ON = "vault scrubber: on (";
const SCRUB_OFF = "vault scrubber: off until a vault key is saved (";
const NOTICE =
  "Your vault key (~/.engram/vault-key) can't be read, so messages wait here rather than be sent with your " +
  "vault's secrets in them. Nothing is lost.";
const WAITS = "Meanwhile, messages wait here rather than be sent with your vault's secrets";
/** Said before a command while the daemon holds messages for the key. */
const BANNER = `engram: ${NOTICE}`;
const statusIs = (health, errorType, pending) => () => {
  const s = syncStatus();
  return s.health === health && s.error_type === errorType && (pending === undefined || s.pending_messages === pending);
};

try {
  // ── 1. signed in, with a vault key, and a secret in the vault ──
  let r = await engram("auth", "login", KEY);
  check(r.status === 0, "auth login exits 0");
  r = await engram("vault", "keygen", "--save");
  check(r.status === 0, "vault keygen --save exits 0");
  check(Buffer.from(knownVaultKey() ?? "", "base64").length === 32, "the vault key is saved: 32 bytes");
  r = await engram("vault", "set", SECRET_NAME, "--value", SECRET);
  check(r.status === 0, "vault set exits 0");
  check(server.vault.has(SECRET_NAME) && reached(SECRET) === 0, "the server keeps the secret encrypted, never as it is");
  r = await engram("vault", "get", SECRET_NAME);
  check(r.status === 0 && r.out.includes("<the secret>"), "vault get decrypts it with the key");

  // ── 2. a folder where the key was: what needs the key refuses, and sends nothing ──
  renameSync(KEY_FILE, KEY_ASIDE);
  mkdirSync(KEY_FILE);
  const before = server.log.length;
  r = await engram("store", "--conversation", "conv_none", `${said("stored")} the door code is ${SECRET}`);
  check(r.status === 1, `store exits 1 (${r.status})`);
  check(r.out.includes(REFUSED(FOLDER)), "store: why, and that nothing was sent");
  check(r.out.includes(FOLDER_FIX) && r.out.includes("Then run this again."), "store: what to do");
  r = await engram("vault", "get", SECRET_NAME);
  check(r.status === 1 && r.out.includes(REFUSED(FOLDER)), `vault get refuses too (${r.status})`);
  check(server.log.length === before, `neither made a request (${server.log.length - before})`);
  r = await engram("vault", "status");
  check(r.out.includes(`the key can't be read: ${FOLDER}`), "vault status: the key can't be read, not 'not configured'");

  // ── 3. the daemon captures and creates, but holds every message ──
  const tStart = Date.now();
  let pid = await startWorker(null);
  await waitFor("daemon.log: holding sends, why, and what to do", () => logCount(HOLDING(FOLDER, FOLDER_FIX)) === 1, 10_000);
  const s1 = session();
  s1.say(`${said("u1")} the door code is ${SECRET}`);
  s1.say(`${said("u2")} and the vault key is ${vaultKey}`);
  s1.say(`${said("u3")} nothing secret in this one`);
  await waitFor("daemon.db: the 3 messages wait", () => unsent() === 3);
  const created = await waitFor("the conversation is created", () => since("create", tStart)[0]);
  check(!JSON.stringify(created?.args ?? {}).includes(said("u")), "the create carries none of what was said");
  await waitFor("status.json: an error, vault_key, 3 waiting", statusIs("error", "vault_key", 3));
  check(logCount(HELD(FOLDER)) === 1, "daemon.log: the syncer says why it holds, once");
  await waitFor("a desktop notification says so", () => stubLines().some((l) => l.includes("Engram needs attention") && l.includes(NOTICE)), 10_000);
  check(kept(SECRET) === 1, "daemon.db holds u1 as it was said, on this machine, until it can be scrubbed");
  r = await engram("status");
  check(r.status === 0, "engram status exits 0");
  check(r.out.includes(`WARNING: ${FOLDER}.`) && r.out.includes(FOLDER_FIX), "engram status: the warning, and what to do");
  check(
    r.out.includes(WAITS) && r.out.includes("in them, and commands that need the key won't run. Nothing is lost."),
    "engram status: messages wait, commands refuse, nothing is lost",
  );
  check(r.out.includes("3 messages waiting to sync"), "engram status: 3 waiting");
  check(since("append", tStart).length === 0, "nothing was sent");
  check(since("vault_", tStart).length === 0, "the vault wasn't read");

  // ── 4. the key put back, with no restart: the vault is read, then all that was held is sent, scrubbed ──
  rmdirSync(KEY_FILE);
  renameSync(KEY_ASIDE, KEY_FILE);
  const tBack = Date.now();
  // Read again 10 s after the daemon starts, then 30 s later, then every minute.
  await waitFor("daemon.log: the key can be read now", () => logCount(READ_NOW) === 1, 75_000);
  await waitFor("the 3 held messages arrive", () => appended(tBack).length === 3, 20_000);
  check(daemonPid() === pid && alive(pid), "the same worker: no restart");
  const firstAppend = server.log.findIndex((x) => x.op === "append");
  const vaultRead = server.log.findIndex((x) => x.op === "vault_get" && x.name === SECRET_NAME && x.t >= tBack);
  check(vaultRead !== -1 && vaultRead < firstAppend, "the vault was read with the key before anything was sent");
  check(since("append", tBack).every((x) => x.conv === created?.conv), "they go to the conversation created meanwhile");
  check(arrived("u1").length === 1 && arrived("u1")[0].includes(`the door code is ${TOKEN}`), `u1 arrives with ${TOKEN} for the secret`);
  check(arrived("u2").length === 1 && arrived("u2")[0].includes(`the vault key is ${KEY_TOKEN}`), `u2 arrives with ${KEY_TOKEN} for the key`);
  check(arrived("u3").length === 1, "u3 arrives");
  check(logCount(SENDING) === 1, "daemon.log: sending what was held");
  await waitFor("status.json: healthy, nothing waiting", statusIs("healthy", null, 0), 10_000);
  check(unsent() === 0, "daemon.db: nothing waits");
  check(kept(SECRET) === 0 && kept(vaultKey) === 0, "daemon.db keeps no copy of the secret or the key");
  r = await engram("status");
  check(r.status === 0 && !r.out.includes("WARNING"), "engram status: no warning");
  // Said once the key could be read: scrubbed before it was queued.
  s1.say(`${said("u4")} once more, ${SECRET}`);
  await waitFor("u4 arrives", () => arrived("u4").length === 1);
  check(arrived("u4")[0]?.includes(`once more, ${TOKEN}`), `u4 arrives with ${TOKEN}`);
  check(kept(SECRET) === 0, "daemon.db never held u4's secret");

  // ── 5. a key the user can't read: held over a restart, then sent scrubbed ──
  if (asRoot) {
    console.log("\nskipped: mode 000 doesn't stop root reading the key");
  } else {
    await stopWorker(pid);
    chmodSync(KEY_FILE, 0o000);
    const t5 = Date.now();
    pid = await startWorker(pid);
    await waitFor("daemon.log: holding sends, permission denied", () => logCount(HOLDING(DENIED, DENIED_FIX)) === 1, 10_000);
    const s2 = session();
    s2.say(`${said("v1")} the door code, again: ${SECRET}`);
    await waitFor("daemon.db: v1 waits", () => unsent() === 1);
    await waitFor("status.json: an error, vault_key, 1 waiting", statusIs("error", "vault_key", 1));
    r = await engram("status");
    check(r.out.includes(`WARNING: ${DENIED}.`) && r.out.includes(DENIED_FIX), "engram status: permission denied, and the chmod");
    check(since("append", t5).length === 0 && since("vault_", t5).length === 0, "nothing sent, and the vault not read");
    await stopWorker(pid);
    check(unsent() === 1, "the stop keeps v1 in daemon.db");
    chmodSync(KEY_FILE, 0o600);
    pid = await startWorker(pid);
    await waitFor("v1 arrives", () => arrived("v1").length === 1);
    check(arrived("v1")[0]?.includes(`again: ${TOKEN}`), `v1 arrives with ${TOKEN}`);
    check(logCount(SCRUB_ON) === 1, "daemon.log: the scrubber is on");
    await waitFor("daemon.db: nothing waits", () => unsent() === 0, 10_000);
  }

  // ── 6. the key gone, after one that couldn't be read: still held; a start without one sends it ──
  await stopWorker(pid);
  renameSync(KEY_FILE, KEY_ASIDE);
  mkdirSync(KEY_FILE);
  const t6 = Date.now();
  pid = await startWorker(pid);
  await waitFor("daemon.log: holding sends, a folder", () => logCount(HOLDING(FOLDER, FOLDER_FIX)) === 2, 10_000);
  const s3 = session();
  s3.say(`${said("w1")} nothing secret here either`);
  await waitFor("daemon.db: w1 waits", () => unsent() === 1);
  rmdirSync(KEY_FILE);
  await waitFor("daemon.log: still holding, the key isn't there any more", () => logCount(STILL(GONE)) === 1, 75_000);
  await waitFor("status.json: still an error, vault_key", statusIs("error", "vault_key", 1), 10_000);
  r = await engram("status");
  check(r.out.includes(`WARNING: ${GONE}.`), "engram status: the key isn't there any more");
  check(r.out.includes("Put your vault key back in it.") && r.out.includes(GONE_FIX), "engram status: put it back, or start without one");
  check(r.out.includes(WAITS) && r.out.includes("  in them. Nothing is lost."), "engram status: messages wait, nothing is lost");
  check(since("append", t6).length === 0 && unsent() === 1, "w1 isn't sent; it waits in daemon.db");
  await stopWorker(pid);
  check(lastOut.includes(`${BANNER} 1 message waiting locally.`), "stop: the daemon held w1, and says so");
  pid = await startWorker(pid);
  check(!lastOut.includes(BANNER), "start: no word of a hold, as the daemon it starts has no key to wait for");
  await waitFor("daemon.log: the scrubber is off", () => logCount(SCRUB_OFF) === 1, 10_000);
  await waitFor("w1 arrives", () => arrived("w1").length === 1);
  await waitFor("daemon.db: nothing waits", () => unsent() === 0, 10_000);
  await waitFor("status.json: healthy", statusIs("healthy", null, 0), 10_000);
  await stopWorker(pid);

  const all = ["u1", "u2", "u3", "u4", ...(asRoot ? [] : ["v1"]), "w1"];
  const counts = all.map((n) => `${n}×${arrived(n).length}`).join(" ");
  check(all.every((n) => arrived(n).length === 1), `everything said arrived, once: nothing lost (${counts})`);
  check(arrived("stored").length === 0, "and nothing from the refused store");
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
  check(!stubLines().some((l) => l.startsWith("launchctl")), "launchctl was never run");
  check(reached(SECRET) === 0, `the secret never reached the server (${reached(SECRET)} requests)`);
  check(vaultKey !== null && reached(vaultKey) === 0, `the vault key never reached the server (${vaultKey ? reached(vaultKey) : "?"} requests)`);
  const files = logText() + (existsSync(STATUS_FILE) ? readFileSync(STATUS_FILE, "utf-8") : "");
  check(!files.includes(SECRET) && !(vaultKey && files.includes(vaultKey)), "daemon.log and status.json never hold either");
  const ops = {};
  for (const x of server.log) ops[`${x.op} [${x.key}]`] = (ops[`${x.op} [${x.key}]`] ?? 0) + 1;
  console.log("\nrequests the server saw:", JSON.stringify(ops, null, 1));
  console.log("\ndaemon.log, the lines about the vault:");
  for (const l of logText().split("\n").filter((l) => /vault|held|holding/.test(l))) console.log(`  ${redact(l)}`);
  srv.close();
  rmSync(root, { recursive: true, force: true });
  console.log(`\n${failures ? `${failures} FAILED` : "all passed"}`);
  process.exit(failures ? 1 : 0);
}
