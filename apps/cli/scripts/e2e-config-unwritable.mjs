#!/usr/bin/env node
/**
 * A ~/.engram/config.json that can't be written, with the CLI as it ships,
 * against a fake Engram server on 127.0.0.1 (engram#717). The unit tests
 * run the commands with the SDK, fetch and readline faked; this runs the
 * built CLI on a file and folders that really are read-only, and checks
 * what reaches the server and what the user is told:
 *
 *   - engram signup and engram login, with config.json, ~/.engram or both
 *     read-only, ask the server for nothing: they say why, what that means
 *     and the chmod that fixes it, exit 1, and change nothing. So does
 *     engram auth login, which doesn't send the key to be checked.
 *   - engram auth logout and engram exclude add and remove, whose save
 *     fails, say the same and change nothing. auth logout with no key
 *     saved has nothing to write, and signs out.
 *   - With no ~/.engram, in a home that can't be written, signup offers no
 *     command, and makes nothing.
 *   - After the chmod they print, run as printed, signup and login save the
 *     key they got with the folders excluded before.
 *
 * Usage, after `pnpm build`:  node scripts/e2e-config-unwritable.mjs
 *
 * Everything happens under a temporary home with made-up keys, and the CLI
 * runs with an environment of its own (no ENGRAM_API_KEY from your shell),
 * so it never touches your ~/.engram or your account. launchctl, osascript,
 * notify-send and systemctl are stubs on its PATH. POSIX only, and not as
 * root, which can write a read-only file: otherwise it skips.
 */
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  console.log("skipped: the modes and stubs here are POSIX-only");
  process.exit(0);
}
if (process.getuid?.() === 0) {
  console.log("skipped: root can write a read-only file");
  process.exit(0);
}

const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));
if (!existsSync(CLI)) {
  console.error(`no build at ${CLI}: run 'pnpm build' first`);
  process.exit(2);
}
const node = process.execPath;

// Made up on each run: they only exist on the fake server below.
const testKey = (name) => `engram_sk_live_e2e_${name}_${randomBytes(12).toString("hex")}`;
const KEYS = { SIGNUP: testKey("signup"), LOGIN: testKey("login"), TYPED: testKey("typed") };
const redact = (s) => s.replace(/engram_sk_live_e2e_\w*/g, "<test key>");
const EMAIL = "e2e-717@example.com";
const LOGIN = ["login", "--email", EMAIL, "--password", "not-a-real-password"];

// ── The fake server: it records every request, and answers the two that make a key
const requests = [];
const srv = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const path = new URL(req.url ?? "/", "http://fake").pathname;
  let email = null;
  try {
    email = JSON.parse(body).email ?? null;
  } catch {}
  requests.push({ op: `${req.method} ${path}`, email });
  const send = (status, value) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  };
  if (req.method === "POST" && path === "/signup/anonymous") {
    return send(200, { organization_id: "org_e2e_717", api_key: KEYS.SIGNUP });
  }
  if (req.method === "POST" && path === "/signup/login") {
    return send(200, { organization_id: "org_e2e_717", api_key: KEYS.LOGIN });
  }
  send(404, { error: "not found" });
});
await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${srv.address().port}`;

// ── The temporary home, the stubs, the CLI ──────────────────────────────────
const root = mkdtempSync(join(tmpdir(), "engram-e2e-717-"));
const home = join(root, "home");
const WORK = join(home, "work");
const OTHER = join(home, "other");
mkdirSync(WORK, { recursive: true });
mkdirSync(OTHER);
chmodSync(home, 0o700);
mkdirSync(join(root, "tmp"));
const fakeBin = join(root, "bin");
mkdirSync(fakeBin);
const STUB_LOG = join(root, "stubs.log");
for (const [name, status] of [["osascript", 0], ["launchctl", 1], ["notify-send", 0], ["systemctl", 1]]) {
  writeFileSync(join(fakeBin, name), `#!/bin/sh\necho "${name} $*" >> "${STUB_LOG}"\nexit ${status}\n`);
  chmodSync(join(fakeBin, name), 0o755);
}
const env = {
  PATH: `${fakeBin}:${dirname(node)}:/bin`,
  HOME: home,
  TMPDIR: join(root, "tmp"),
  ENGRAM_BASE_URL: baseUrl,
  ENGRAM_NO_AUTOCAPTURE: "1",
  // No ENGRAM_API_KEY: commands that use a key would take it over the file.
};
const ENGRAM_DIR = join(home, ".engram");
const CONFIG = join(ENGRAM_DIR, "config.json");

/** Put modes back, so the next step, and the cleanup, can write. */
function writable() {
  chmodSync(home, 0o700);
  if (existsSync(ENGRAM_DIR)) chmodSync(ENGRAM_DIR, 0o700);
  if (existsSync(CONFIG)) chmodSync(CONFIG, 0o600);
}
process.on("SIGINT", () => {
  writable();
  rmSync(root, { recursive: true, force: true });
  process.exit(130);
});

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) failures++;
  return ok;
}

/** Run the built CLI as a user would. Async: the fake server is in this process. */
function engram(...args) {
  return new Promise((resolve) => {
    const child = spawn(node, [CLI, ...args], { env, cwd: home, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
      out = plain(out);
      err = plain(err);
      console.log(`\n$ engram ${redact(args.join(" "))}  (exit ${status})`);
      for (const line of redact(out + err).trimEnd().split("\n")) console.log(`  │ ${line}`);
      resolve({ status, out, err });
    });
  });
}

/** Run, in the temporary home, the command the CLI said fixes it, as it said it. */
function runFix(fix) {
  const r = spawnSync("/bin/sh", ["-c", fix], { env, cwd: home, encoding: "utf-8" });
  check(r.status === 0, `'${fix}' runs as printed${r.status === 0 ? "" : `: ${r.stderr.trim()}`}`);
}

const modeOf = (p) => (existsSync(p) ? (statSync(p).mode & 0o777).toString(8) : null);
/** Everything a command could change: the modes, the files and what's in config.json. */
function state() {
  return JSON.stringify({
    home: modeOf(home),
    homeFiles: readdirSync(home).sort(),
    dir: modeOf(ENGRAM_DIR),
    files: existsSync(ENGRAM_DIR) ? readdirSync(ENGRAM_DIR).sort() : null,
    config: existsSync(CONFIG) ? readFileSync(CONFIG, "utf-8") : null,
    configMode: modeOf(CONFIG),
  });
}
const saved = () => JSON.parse(readFileSync(CONFIG, "utf-8"));

/** The lines a command that can't save says, as each command words them. */
function refusal(meaning, again, fix) {
  return [
    "Error: ~/.engram/config.json can't be written: permission denied.",
    ...meaning.map((l) => (l instanceof RegExp ? l : `  ${l}`)),
    ...(fix ? [`  To fix it, run: ${fix}`, `  Then run ${again} again.`] : [`  Once it's fixed, run ${again} again.`]),
  ];
}
/** Whether `block` is in `text`, as consecutive lines. */
function says(text, block) {
  const lines = text.trimEnd().split("\n");
  const is = (line, want) => (want instanceof RegExp ? want.test(line) : line === want);
  return lines.some((_, i) => block.every((want, j) => i + j < lines.length && is(lines[i + j], want)));
}

/** `args` stops before doing anything: exit 1, the lines, nothing sent, nothing changed. */
async function refuses(args, block, what, { pathSaid = false } = {}) {
  const before = state();
  const sent = requests.length;
  const r = await engram(...args);
  check(r.status === 1, `${what}: exits 1 (${r.status})`);
  const fix = block.some((l) => typeof l === "string" && l.startsWith("  To fix it"));
  check(says(r.err, block), `${what}: says why, what that means and ${fix ? "the chmod that fixes it" : "no command to run"}`);
  const extra = requests.slice(sent).map((x) => x.op);
  check(extra.length === 0, `${what}: asks the server for nothing${extra.length ? ` (sent: ${extra.join(", ")})` : ""}`);
  check(state() === before, `${what}: changes nothing in ~/.engram, its config.json or the home folder`);
  check(!/engram_sk_live_e2e/.test(r.out + r.err), `${what}: prints no API key`);
  if (!pathSaid) check(!(r.out + r.err).includes(root), `${what}: prints no full path`);
  return r;
}

const SIGNUP_MEANS = ["A new account's API key is saved there, so no account was made."];
const LOGIN_MEANS = ["Signing in saves a new API key there, so it wasn't tried."];
const FILE_FIX = "chmod u+w ~/.engram/config.json";

try {
  // Folders excluded before: what each failed save must keep, and each
  // successful one save with the new key.
  const added = await engram("exclude", "add", WORK);
  check(added.status === 0, "exclude add, with nothing in the way, exits 0");
  check(modeOf(ENGRAM_DIR) === "700" && modeOf(CONFIG) === "600", "it made ~/.engram (0700) and config.json (0600)");
  const excluded = saved().excludePaths;
  check(Array.isArray(excluded) && excluded.length === 1 && saved().apiKey === undefined, "config.json lists one folder, and no key");

  // ── config.json read-only, no key saved
  chmodSync(CONFIG, 0o400);
  await refuses(["signup"], refusal(SIGNUP_MEANS, "'engram signup'", FILE_FIX), "signup with config.json read-only");
  await refuses(
    ["exclude", "add", OTHER],
    refusal([/^ {2}Not excluded: sessions in .+ are still captured\.$/], "this", FILE_FIX),
    "exclude add with config.json read-only",
    { pathSaid: true },
  );
  {
    const before = state();
    const sent = requests.length;
    const r = await engram("auth", "logout");
    check(r.status === 0 && r.out.includes("✓ Logged out"), "auth logout with no key saved signs out, though config.json is read-only");
    check(state() === before && requests.length === sent, "  and writes nothing, and asks the server for nothing");
  }

  runFix(FILE_FIX);
  {
    const sent = requests.length;
    const r = await engram("signup");
    check(r.status === 0 && r.out.includes("✓ Account created"), "after the chmod, signup makes the account");
    const extra = requests.slice(sent).map((x) => x.op);
    check(extra.join() === "POST /signup/anonymous", `  with one request (${extra.join(", ")})`);
    const c = saved();
    check(c.apiKey === KEYS.SIGNUP && JSON.stringify(c.excludePaths) === JSON.stringify(excluded), "  and saves its key, with the folder excluded before");
    check(modeOf(CONFIG) === "600" && readdirSync(ENGRAM_DIR).join() === "config.json", "  config.json is 0600, and no temp file is left");
  }

  // ── config.json read-only, a key saved
  chmodSync(CONFIG, 0o400);
  await refuses(LOGIN, refusal(LOGIN_MEANS, "'engram login'", FILE_FIX), "login with config.json read-only");
  await refuses(
    ["auth", "login", KEYS.TYPED],
    refusal(["So the key wasn't checked or saved."], "this", FILE_FIX),
    "auth login with config.json read-only",
  );
  await refuses(
    ["auth", "logout"],
    refusal(["You're still signed in, and auto-capture keeps using the key saved there."], "'engram auth logout'", FILE_FIX),
    "auth logout with config.json read-only",
  );
  await refuses(
    ["exclude", "remove", WORK],
    refusal([/^ {2}Still excluded from capture: .+$/], "this", FILE_FIX),
    "exclude remove with config.json read-only",
    { pathSaid: true },
  );

  // ── both read-only
  chmodSync(ENGRAM_DIR, 0o500);
  const BOTH_FIX = "chmod u+w ~/.engram ~/.engram/config.json";
  await refuses(LOGIN, refusal(LOGIN_MEANS, "'engram login'", BOTH_FIX), "login with ~/.engram and config.json read-only");

  runFix(BOTH_FIX);
  {
    const sent = requests.length;
    const r = await engram(...LOGIN);
    check(r.status === 0 && r.out.includes(`✓ Signed in as ${EMAIL}`), "after the chmod, login signs in");
    const extra = requests.slice(sent);
    check(extra.map((x) => x.op).join() === "POST /signup/login" && extra[0]?.email === EMAIL, `  with one request, for ${EMAIL}`);
    const c = saved();
    check(c.apiKey === KEYS.LOGIN && JSON.stringify(c.excludePaths) === JSON.stringify(excluded), "  and saves the new key, with the folder excluded before");
    check(modeOf(ENGRAM_DIR) === "700" && modeOf(CONFIG) === "600", "  ~/.engram is 0700 and config.json 0600 again");
    check(readdirSync(ENGRAM_DIR).join() === "config.json", "  no temp file is left");
  }

  // ── ~/.engram read-only, config.json writable: the new file is made in the folder
  chmodSync(ENGRAM_DIR, 0o500);
  await refuses(LOGIN, refusal(LOGIN_MEANS, "'engram login'", "chmod u+w ~/.engram"), "login with ~/.engram read-only");
  runFix("chmod u+w ~/.engram");

  // ── no ~/.engram, in a home that can't be written: not Engram's to fix
  rmSync(ENGRAM_DIR, { recursive: true, force: true });
  chmodSync(home, 0o500);
  await refuses(["signup"], refusal(SIGNUP_MEANS, "'engram signup'", null), "signup with no ~/.engram in a read-only home");
  check(!existsSync(ENGRAM_DIR), "  and makes no ~/.engram");
  chmodSync(home, 0o700);
} catch (err) {
  check(false, `threw: ${redact(err instanceof Error ? (err.stack ?? err.message) : String(err))}`);
} finally {
  writable();
  const ops = requests.map((x) => x.op);
  check(
    ops.join() === "POST /signup/anonymous,POST /signup/login",
    `the server was asked for a key twice, once each after the chmod (${ops.join(", ") || "nothing"})`,
  );
  const stubs = existsSync(STUB_LOG) ? readFileSync(STUB_LOG, "utf-8").split("\n").filter(Boolean) : [];
  // launchctl may only look for the job a sudo install could have loaded
  // into launchd's system domain, which changes nothing (engram#680).
  const ran = stubs.filter((l) => l !== "launchctl print system/app.getengram.daemon");
  check(ran.length === 0, `no stub was run${ran.length ? ` (ran: ${ran.join("; ")})` : ""}`);
  srv.close();
  rmSync(root, { recursive: true, force: true });
  console.log(`\n${failures ? `${failures} FAILED` : "all passed"}`);
  process.exit(failures ? 1 : 0);
}
