import { execSync, execFileSync, type ChildProcess } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { bold, dim, red } from "../output.js";
import { loadConfig, saveConfig } from "../config.js";
import { readStatus, syncErrorSummary, captureErrorSummary, type SyncStatus } from "./status.js";
import { ALL_ADAPTERS } from "./adapters.js";
import {
  ENGRAM_DIR,
  LOG_FILE,
  PID_FILE,
  loginStartPath,
  readPidFile,
  spawnWorker,
  workerPath,
} from "./launch.js";

/** Render the per-host capture status (engram#261). */
function printHostStatus(): void {
  console.log(`${dim("Hosts:")}`);
  for (const a of ALL_ADAPTERS) {
    const on = a.available();
    const mark = on ? "✓" : "·";
    const state = on ? "capturing" : "not installed";
    console.log(`  ${mark} ${a.label.padEnd(14)} ${dim(state)}`);
  }
}

const DB_FILE = join(ENGRAM_DIR, "daemon.db");
const PLIST_NAME = "app.getengram.daemon";
const PLIST_DIR = join(homedir(), "Library", "LaunchAgents");
const PLIST_PATH = join(PLIST_DIR, `${PLIST_NAME}.plist`);

// Bump when generatePlist() changes in a way existing installs must pick up.
// A plist is written once at install time and never revisited, so upgrading
// the CLI alone does NOT fix a defect that lives in the plist — the stale file
// keeps launching the old thing. Every machine installed before v2 is still
// pointing launchd at `worker-main.js`, the pre-0.4.2 entry point that has no
// ABI preflight, which is why the self-heal shipped in 0.4.2 has never once
// run on them (engram#469).
//
// v2: launch `worker.js` (preflight bootstrap) and give the job a PATH.
const PLIST_VERSION = 2;

function readPid(): number | null {
  // The PID file first; a launchd-managed worker may not have written one.
  return readPidFile() ?? readLaunchdPid();
}

function readLaunchdPid(): number | null {
  if (!isLaunchdInstalled()) return null;
  try {
    const output = execSync(`launchctl list ${PLIST_NAME} 2>/dev/null`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const match = output.match(/"PID"\s*=\s*(\d+)/);
    if (match) return parseInt(match[1], 10);
    // Also check the tabular format: PID\tStatus\tLabel
    const lines = output.trim().split("\n");
    for (const line of lines) {
      const parts = line.split("\t");
      if (parts.length >= 1) {
        const pid = parseInt(parts[0], 10);
        if (!isNaN(pid) && pid > 0) return pid;
      }
    }
  } catch {
    // not loaded
  }
  return null;
}

export async function daemonStart(
  _args: string[],
  flags: Record<string, string>,
): Promise<void> {
  await recordCaptureIntent("on");
  const existing = readPid();
  if (existing) {
    console.log(`Daemon already running (pid ${existing})`);
    // --install still asks for start at login (engram#602). Not on macOS:
    // loading the launchd agent there starts a second worker beside this one.
    if ("install" in flags && process.platform !== "darwin") {
      await enableStartAtLogin(true);
    }
    return;
  }

  const foreground = "foreground" in flags || "f" in flags;

  if (foreground) {
    console.log("Starting daemon in foreground...");
    // Import and run worker directly
    await import("./worker.js");
    return;
  }

  // A stale plist survives every CLI upgrade, so check it here rather than
  // only at install time (engram#469). The Windows entry likewise.
  migrateLaunchdIfStale();
  repairRunEntryIfBroken();

  if (!reportStart(await waitForWorker(spawnWorker()))) {
    process.exit(1);
    return;
  }
  console.log(`${dim("Log:")} ${LOG_FILE}`);
  console.log(`${dim("DB:")}  ${DB_FILE}`);

  if ("install" in flags) {
    await enableStartAtLogin(true);
  }
}

/** Say how a worker just spawned got on; false when it didn't start. */
function reportStart(started: WorkerStart): boolean {
  if (started.state === "failed") {
    console.error("Daemon failed to start. Check the log:");
    console.error(`  ${process.platform === "win32" ? "type" : "cat"} "${LOG_FILE}"`);
    return false;
  }
  if (started.state === "running") {
    console.log(`${bold("Engram daemon started")} (pid ${started.pid})`);
  } else {
    // Still loading: most often the preflight rebuilding better-sqlite3 for
    // a Node it wasn't built for, which takes a minute or two.
    console.log(`${bold("Engram daemon is starting")} (pid ${started.pid}) — this one is taking a while`);
    console.log(dim("  Check on it with 'engram status' in a minute."));
  }
  return true;
}

export type WorkerStart =
  | { state: "running"; pid: number } // it has written its PID file
  | { state: "starting"; pid: number } // alive, still loading
  | { state: "failed" }; // it exited, or never started

/**
 * Wait for a worker just spawned to write its PID file, which it does once
 * its modules have loaded. A fixed half-second pause was too short on
 * Windows, where Node loads slowly the first time while antivirus scans each
 * file: `engram start` reported a failure, exited 1 and skipped --install,
 * and the daemon came up a moment later (engram#602). Gives up as soon as
 * the worker exits.
 */
export async function waitForWorker(child: ChildProcess, timeoutMs = 10_000): Promise<WorkerStart> {
  let failed = false;
  child.once("exit", () => {
    failed = true;
  });
  child.once("error", () => {
    failed = true;
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    // The PID file before the exit: a worker that wrote it and then died
    // leaves a stale file, which readPid removes.
    const pid = readPid();
    if (pid !== null) return { state: "running", pid };
    if (failed) return { state: "failed" };
  }
  if (failed || child.pid === undefined) return { state: "failed" };
  return { state: "starting", pid: child.pid };
}

async function recordCaptureIntent(v: "on" | "off"): Promise<void> {
  try {
    const config = await loadConfig();
    config.autocapture = v;
    await saveConfig(config);
  } catch {
    // config write failures never block daemon management
  }
}

export async function daemonStop(): Promise<void> {
  await recordCaptureIntent("off");
  const pid = readPid();
  if (!pid) {
    console.log("Daemon is not running.");
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    console.log(`Daemon stopped (pid ${pid})`);
  } catch {
    console.error(`Failed to stop daemon (pid ${pid})`);
  }

  // Clean up PID file
  try { unlinkSync(PID_FILE); } catch { /* ignore */ }
}

/** Print local capture stats; never let a broken native module crash status. */
async function printDbStats(): Promise<void> {
  if (!existsSync(DB_FILE)) return;
  try {
    const { DaemonDb } = await import("./db.js");
    const db = new DaemonDb(DB_FILE);
    const stats = db.getStats();
    db.close();
    console.log(`${dim("Sessions captured:")} ${stats.sessionsMapped}`);
    console.log(`${dim("Pending sync:")}      ${stats.pendingMessages} messages`);
    console.log(`${dim("Files tracked:")}     ${stats.trackedFiles}`);
  } catch {
    console.log(dim("Local capture DB unreadable (native module mismatch?) — the daemon rebuilds it on start."));
  }
}

export async function daemonStatus(): Promise<void> {
  const pid = readPid();

  if (!pid) {
    console.log(`${bold("Status:")} stopped`);

    // Still show DB stats if available
    await printDbStats();
    // A broken start-at-login entry is often why it's stopped.
    printAutoStart();
    return;
  }

  console.log(`${bold("Status:")} running (pid ${pid})`);

  await printDbStats();

  printHostStatus();

  // Show sync health warnings
  const syncStatus = readStatus();
  printSyncWarnings(syncStatus);

  console.log(`${dim("Log:")} ${LOG_FILE}`);

  printAutoStart();
}

function printAutoStart(): void {
  if (isLaunchdInstalled()) {
    const stale = installedPlistVersion() < PLIST_VERSION;
    console.log(
      `${dim("Auto-start:")} enabled (launchd)` +
        (stale ? red("  — outdated config, run 'engram start' to update") : ""),
    );
  }

  const entry = readRunEntry();
  if (entry === null) return;
  if (runEntryBroken(entry)) {
    console.log(`${dim("Auto-start:")} enabled (Windows sign-in)` + red("  — broken, run 'engram start' to repair"));
  } else if (switchedOffInStartupApps()) {
    console.log(
      `${dim("Auto-start:")} off — switched off in Windows Startup apps` +
        dim("  ('engram install' turns it back on)"),
    );
  } else {
    console.log(`${dim("Auto-start:")} enabled (Windows sign-in)`);
  }
}

function printSyncWarnings(status: SyncStatus): void {
  // Capture comes before sending: what can't be queued here can't be sent
  // either, however healthy syncing is (engram#584).
  if (status.capture_error) {
    console.log("");
    console.log(red(`  WARNING: ${captureErrorSummary(status.capture_error)}`));
    console.log(dim(`  Since: ${status.capture_error.since}`));
    console.log("");
  }

  if (status.health === "healthy") {
    if (status.last_sync_at) {
      console.log(`${dim("Last sync:")}        ${status.last_sync_at}`);
    }
    return;
  }

  // The same words as the daemon's log line and desktop notification. This
  // kept a copy of its own, which had no storage_full entry: a full account
  // showed the raw server error instead of what to do about it.
  const msg = syncErrorSummary(status.error_type, status.storage);

  console.log("");
  console.log(red(`  WARNING: ${msg}`));
  if (status.pending_messages > 0) {
    console.log(red(`  ${status.pending_messages} messages waiting to sync`));
  }
  if (status.last_error_at) {
    console.log(dim(`  Since: ${status.last_error_at}`));
  }
  console.log("");
}

// ── Launchd integration ──

function generatePlist(): string {
  const nodePath = process.execPath;
  // launchd hands a job a bare PATH (/usr/bin:/bin:/usr/sbin:/sbin) — npm is
  // not on it. The ABI self-heal in preflight.ts shells out to `npm rebuild
  // better-sqlite3`, so without this it fails with command-not-found at the
  // exact moment it is needed. npm ships beside the node binary, so putting
  // node's own directory first makes the heal reachable.
  const nodeBinDir = dirname(nodePath);
  const jobPath = `${nodeBinDir}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${workerPath()}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${homedir()}</string>
    <key>PATH</key>
    <string>${jobPath}</string>
    <key>ENGRAM_PLIST_VERSION</key>
    <string>${PLIST_VERSION}</string>
  </dict>
</dict>
</plist>`;
}

/** Version stamped into an installed plist; 1 for plists written before stamping. */
function installedPlistVersion(): number {
  try {
    const xml = readFileSync(PLIST_PATH, "utf-8");
    const m = xml.match(
      /<key>ENGRAM_PLIST_VERSION<\/key>\s*<string>(\d+)<\/string>/,
    );
    return m ? parseInt(m[1], 10) : 1;
  } catch {
    return 1;
  }
}

/**
 * Rewrite and reload a stale launchd plist (engram#469).
 *
 * Without this, a plist defect is permanent: `brew upgrade` / `npm i -g`
 * replaces the code but leaves the plist, so the machine keeps launching the
 * old entry point forever. That is how a self-heal shipped in 0.4.2 was still
 * inert on a 0.6.0 install. Runs on any daemon start; silent when current.
 */
export function migrateLaunchdIfStale(): boolean {
  if (process.platform !== "darwin") return false;
  if (!isLaunchdInstalled()) return false;
  if (installedPlistVersion() >= PLIST_VERSION) return false;

  try {
    writeFileSync(PLIST_PATH, generatePlist());
  } catch {
    return false; // not fatal — the daemon can still run in this session
  }

  // bootout/bootstrap is the modern pair; fall back to unload/load on older
  // macOS. Either way a failure here is non-fatal: the new plist is on disk
  // and takes effect at next login.
  const uid = process.getuid?.() ?? 0;
  try {
    execSync(`launchctl bootout gui/${uid}/${PLIST_NAME}`, { stdio: "pipe" });
  } catch {
    try {
      execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: "pipe" });
    } catch {
      // already unloaded
    }
  }
  try {
    execSync(`launchctl bootstrap gui/${uid} "${PLIST_PATH}"`, { stdio: "pipe" });
  } catch {
    try {
      execSync(`launchctl load -w "${PLIST_PATH}"`, { stdio: "pipe" });
    } catch {
      // takes effect at next login
    }
  }
  console.log(
    `${bold("Updated auto-start configuration")} ${dim(`(plist v${PLIST_VERSION})`)}`,
  );
  return true;
}

function isLaunchdInstalled(): boolean {
  // Darwin only: CLIs before engram#602 wrote this plist on every platform,
  // and a stray copy must not read as "auto-start enabled" or send status
  // shelling out to launchctl on Windows.
  return process.platform === "darwin" && existsSync(PLIST_PATH);
}

function installLaunchd(): void {
  mkdirSync(PLIST_DIR, { recursive: true });
  writeFileSync(PLIST_PATH, generatePlist());

  try {
    execSync(`launchctl load -w "${PLIST_PATH}"`, { stdio: "pipe" });
    console.log(`${bold("Auto-start enabled")} — daemon will start on login`);
    console.log(`${dim("Plist:")} ${PLIST_PATH}`);
  } catch {
    console.log(`Plist written to ${PLIST_PATH}`);
    console.log("Run manually: launchctl load -w " + PLIST_PATH);
  }
}

function uninstallLaunchd(): void {
  if (!isLaunchdInstalled()) {
    console.log("Launchd agent not installed.");
    return;
  }

  try {
    execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: "pipe" });
  } catch {
    // may already be unloaded
  }

  try {
    unlinkSync(PLIST_PATH);
  } catch {
    // ignore
  }

  console.log(`${bold("Auto-start disabled")} — launchd agent removed`);
}

// ── Windows: a per-user Run entry ──
//
// HKCU\…\Run is per-user sign-in startup: it needs no admin rights, it is
// what apps' "open at login" settings use, and Windows lists it under Startup
// apps, where it can be switched off. (A Task Scheduler logon task would work
// too, but creating one with schtasks can take admin rights.)

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE = "Engram";

// Switching an entry off under Startup apps (Settings, Task Manager) leaves
// it in the Run key and writes a value of the same name here instead: its
// first byte is 3 for off, 2 or 6 for on, and no value at all is on. The
// format is undocumented; "an odd first byte is off" is the observed rule.
// Without reading it, status said "enabled" for an entry Windows skips.
const APPROVED_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";

/**
 * reg.exe by absolute path: a bare name is looked up in the current
 * directory before PATH on Windows.
 */
function regExe(): string {
  return win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe");
}

/** The command line Windows runs at sign-in. Exported for tests. */
export function runEntryCommand(nodePath: string, entryPath: string): string {
  return `"${nodePath}" "${entryPath}"`;
}

/**
 * Node's own path, through any links. A version manager can start Node
 * through a link made for one shell session (fnm's multishell directories),
 * which may be gone by the next sign-in; the program it links to stays.
 */
function nodePathForEntry(): string {
  try {
    return realpathSync.native(process.execPath);
  } catch {
    return process.execPath;
  }
}

/**
 * Our value's data in a `reg export` of the Run key: null when it isn't
 * there, "" when it is but isn't a plain string. Exported for tests.
 *
 * The export, not `reg query`: reg prints in the console's code page, so a
 * path with a letter outside it (the "í" of "C:\Users\Ana María\…") came
 * back mangled and a working entry read as broken. The export is UTF-16.
 */
export function parseRunExport(exported: string): string | null {
  const data = exportedData(exported);
  if (data === null) return null;
  const quoted = data.match(/^"((?:[^"\\]|\\.)*)"$/);
  return quoted ? quoted[1].replace(/\\(.)/g, "$1") : "";
}

/**
 * Whether a `reg export` of the StartupApproved key has our entry switched
 * off (see APPROVED_KEY). Exported for tests.
 */
export function parseApprovedExport(exported: string): boolean {
  const first = exportedData(exported)?.match(/^hex:([0-9a-f]{2})/i);
  return !!first && parseInt(first[1], 16) % 2 === 1;
}

/** What follows `"Engram"=` in an exported key, or null when it isn't there. */
function exportedData(exported: string): string | null {
  const name = `"${RUN_VALUE.toLowerCase()}"=`;
  let inKey = false;
  for (const line of exported.split(/\r?\n/)) {
    if (line.startsWith("[")) {
      // The key's own values come first; any subkeys follow.
      if (inKey) break;
      inKey = true;
    } else if (inKey && line.toLowerCase().startsWith(name)) {
      return line.slice(name.length);
    }
  }
  return null;
}

function runReg(args: string[]): string {
  return execFileSync(regExe(), args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

/** A registry key as `reg export` writes it; null when reg can't (no such key). */
function exportKey(key: string): string | null {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), "engram-"));
    const file = join(dir, "key.reg");
    runReg(["export", key, file, "/y"]);
    const bytes = readFileSync(file);
    const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe;
    return bytes.toString(utf16 ? "utf16le" : "utf-8");
  } catch {
    return null;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/** The installed entry's command line; null when there is none, or off Windows. */
function readRunEntry(): string | null {
  if (process.platform !== "win32") return null;
  const exported = exportKey(RUN_KEY);
  return exported === null ? null : parseRunExport(exported);
}

/** The user switched our entry off under Startup apps. */
function switchedOffInStartupApps(): boolean {
  if (process.platform !== "win32") return false;
  const exported = exportKey(APPROVED_KEY);
  return exported !== null && parseApprovedExport(exported);
}

/**
 * Forget a Startup apps switch-off: no value there means on. For install and
 * uninstall only, which are the user asking for it on or gone; `engram
 * start` repairs a broken entry but leaves the switch where the user put it.
 */
function clearStartupSwitch(): void {
  try {
    runReg(["delete", APPROVED_KEY, "/v", RUN_VALUE, "/f"]);
  } catch {
    // never switched
  }
}

/** Either program the entry names is gone (Node moved, CLI uninstalled). */
function runEntryBroken(entry: string): boolean {
  const m = entry.match(/^"([^"]+)"\s+"([^"]+)"$/);
  return !m || !existsSync(m[1]) || !existsSync(m[2]);
}

function writeRunEntry(): boolean {
  try {
    runReg([
      "add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ",
      "/d", runEntryCommand(nodePathForEntry(), loginStartPath()), "/f",
    ]);
    return true;
  } catch {
    return false;
  }
}

function deleteRunEntry(): boolean {
  try {
    runReg(["delete", RUN_KEY, "/v", RUN_VALUE, "/f"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Point a broken entry at this CLI, the counterpart of migrateLaunchdIfStale:
 * an entry naming a Node or a CLI that has since moved fails at every
 * sign-in without a word. A working entry is left as it is.
 */
export function repairRunEntryIfBroken(): boolean {
  const entry = readRunEntry();
  if (entry === null || !runEntryBroken(entry)) return false;
  if (!existsSync(loginStartPath()) || !writeRunEntry()) return false;
  console.log(bold("Updated the start-at-login entry"));
  return true;
}

/** The plist CLIs before engram#602 wrote off macOS too. */
function removeStrayPlist(): void {
  try {
    unlinkSync(PLIST_PATH);
  } catch {
    // none written
  }
}

// ── Start at login, per platform ──

/** "Windows", "Linux", … for the messages below. */
function platformLabel(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return platform;
  }
}

/**
 * Start at login: a launchd agent on macOS, a Run entry on Windows
 * (engram#602). Off those, this used to write a macOS plist into
 * ~/Library/LaunchAgents and run a launchctl that isn't there; now it says
 * what actually happens. `running`: whether a daemon is up right now.
 */
async function enableStartAtLogin(running: boolean): Promise<void> {
  if (process.platform === "darwin") {
    installLaunchd();
    return;
  }
  if (process.platform === "win32") {
    await enableWindowsStartAtLogin(running);
    return;
  }
  console.log(bold(`Start at login isn't available on ${platformLabel()} yet.`));
  console.log(
    dim(
      running
        ? "  The daemon keeps running until you sign out or restart. Run 'engram start' again after that."
        : "  Run 'engram start' to capture now, and again after you sign out or restart.",
    ),
  );
}

async function enableWindowsStartAtLogin(running: boolean): Promise<void> {
  removeStrayPlist();
  const entryPath = loginStartPath();
  if (!existsSync(entryPath)) {
    // Only a source checkout run through tsx gets here: the build ships it.
    console.error(red(`Can't turn on start at login: ${entryPath} is missing.`));
    return;
  }
  if (!writeRunEntry()) {
    console.error(red("Couldn't add the Windows startup entry."));
    console.error(dim(`  It goes in ${RUN_KEY} as "${RUN_VALUE}". Run 'engram install' to try again.`));
    return;
  }
  clearStartupSwitch();
  console.log(`${bold("Auto-start enabled")} — daemon will start when you sign in to Windows`);
  console.log(dim("  A console window flashes briefly at sign-in while it starts."));
  console.log(`${dim("Startup entry:")} ${RUN_KEY}\\${RUN_VALUE}`);
  // launchctl load starts the agent right away on macOS; match that, but
  // never start a second worker beside a running one.
  if (!running && !reportStart(await waitForWorker(spawnWorker()))) {
    process.exitCode = 1;
  }
}

function disableStartAtLogin(): void {
  if (process.platform === "darwin") {
    uninstallLaunchd();
    return;
  }
  removeStrayPlist();
  if (process.platform === "win32") {
    if (readRunEntry() === null) {
      console.log("Auto-start isn't on.");
    } else if (deleteRunEntry()) {
      clearStartupSwitch();
      console.log(`${bold("Auto-start disabled")} — the Windows startup entry is removed`);
    } else {
      console.error(red("Couldn't remove the Windows startup entry."));
      console.error(dim(`  Remove "${RUN_VALUE}" from ${RUN_KEY}, or switch it off under Startup apps.`));
      return;
    }
    if (readPid() !== null) {
      console.log(dim("  The daemon keeps running until 'engram stop' or sign-out."));
    }
    return;
  }
  console.log(`Start at login isn't set up on ${platformLabel()}, so there is nothing to remove.`);
}

export async function daemonInstall(): Promise<void> {
  await recordCaptureIntent("on");
  await enableStartAtLogin(readPid() !== null);
}

/**
 * Auto-capture is the product default: a successful interactive login
 * turns the capture daemon on and enables start-at-login, loudly, with a
 * one-line off switch. Never fatal — login must succeed even if the
 * daemon can't start. Skipped for scripted logins (no TTY) and when
 * ENGRAM_NO_AUTOCAPTURE is set.
 */
export async function autoEnableCapture(): Promise<void> {
  if (process.env.ENGRAM_NO_AUTOCAPTURE) return;
  if (!process.stdin.isTTY) return;
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  try {
    const config = await loadConfig();
    if (config.autocapture === "off") return; // user said stop; respect it
    if (!(process.env.ENGRAM_API_KEY ?? config.apiKey)) return; // nothing to capture into
    if (!readPid()) {
      spawnWorker();
      await new Promise((r) => setTimeout(r, 500));
    }
    if (process.platform === "darwin" && !isLaunchdInstalled()) {
      installLaunchd();
    } else {
      migrateLaunchdIfStale();
    }
    console.log(
      `${bold("Auto-capture is on")} — conversations from supported agents on this machine save to your Engram.`,
    );
    if (process.platform !== "darwin") {
      console.log(
        dim(`  Start at login isn't available on ${platformLabel()} yet: run 'engram start' after a restart.`),
      );
    }
    console.log(dim("  Turn off anytime: engram stop && engram uninstall"));
  } catch {
    // Non-fatal by design: capture is a convenience, login is the job.
  }
}

export async function daemonUninstall(): Promise<void> {
  await recordCaptureIntent("off");
  disableStartAtLogin();
}
