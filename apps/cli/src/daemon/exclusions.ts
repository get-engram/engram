import { statSync, existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { homedir } from "node:os";

// Capture exclusions (engram#462): two ways to keep a session out of Engram.
//
// 1. Path exclusions — `engram exclude add <path>` stores absolute paths in
//    ~/.engram/config.json; any session whose cwd is at or under an excluded
//    path is never queued. A committable `.engramignore` marker file at a
//    repo root does the same for everyone who clones the repo.
//
// 2. In-chat opt-out — saying "don't save this to engram" (or `engram:ignore`)
//    in a Claude/Codex session stops capture for that session AND erases what
//    was already captured, locally and server-side (see syncer.ts).
//
// Both checks run in the daemon's message funnel (syncer.onMessages), so an
// excluded session is dropped before anything touches the queue or network.

const CONFIG_FILE = join(homedir(), ".engram", "config.json");
export const IGNORE_MARKER = ".engramignore";

// ── Config-based path exclusions (hot-reloaded) ──

// The daemon is long-lived; `engram exclude add` must take effect without a
// restart. Re-read config.json only when its mtime changes — a stat per
// message batch is negligible.
let cachedPaths: string[] = [];
let cachedMtimeMs = -1;

/** Normalize for prefix comparison: absolute, no trailing separator. */
export function normalizeExcludePath(p: string): string {
  const abs = resolve(p);
  return abs.endsWith(sep) ? abs.slice(0, -sep.length) : abs;
}

export function loadExcludePaths(configFile: string = CONFIG_FILE): string[] {
  try {
    const mtimeMs = statSync(configFile).mtimeMs;
    if (mtimeMs !== cachedMtimeMs) {
      const raw = JSON.parse(readFileSync(configFile, "utf-8")) as {
        excludePaths?: string[];
      };
      cachedPaths = (raw.excludePaths ?? []).map(normalizeExcludePath);
      cachedMtimeMs = mtimeMs;
    }
  } catch {
    cachedPaths = [];
    cachedMtimeMs = -1;
  }
  return cachedPaths;
}

/** True when `cwd` is at or under `excluded` (never a sibling-prefix match:
 *  /a/repo does NOT match /a/repo2). */
export function isUnder(cwd: string, excluded: string): boolean {
  const c = normalizeExcludePath(cwd);
  return c === excluded || c.startsWith(excluded + sep);
}

// ── .engramignore marker files ──

// Walking to the filesystem root per batch would be wasteful; sessions keep a
// stable cwd, so cache the verdict per directory. The daemon is restarted
// rarely — a freshly added marker applies to new sessions immediately via the
// negative-TTL below.
const markerCache = new Map<string, { found: boolean; at: number }>();
const NEGATIVE_TTL_MS = 60_000; // re-check "no marker" dirs once a minute

export function hasIgnoreMarker(cwd: string, nowMs: number = Date.now()): boolean {
  const start = normalizeExcludePath(cwd);
  const cached = markerCache.get(start);
  if (cached && (cached.found || nowMs - cached.at < NEGATIVE_TTL_MS)) {
    return cached.found;
  }

  let dir = start;
  let found = false;
  // Walk up to the filesystem root looking for the marker.
  for (;;) {
    if (existsSync(join(dir, IGNORE_MARKER))) {
      found = true;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  markerCache.set(start, { found, at: nowMs });
  return found;
}

/** Test hook: reset module caches. */
export function resetExclusionCaches(): void {
  markerCache.clear();
  cachedPaths = [];
  cachedMtimeMs = -1;
}

/** Full path check: config exclusions + .engramignore markers. */
export function isPathExcluded(
  cwd: string | undefined,
  configFile: string = CONFIG_FILE,
): boolean {
  if (!cwd) return false;
  const paths = loadExcludePaths(configFile);
  if (paths.some((p) => isUnder(cwd, p))) return true;
  return hasIgnoreMarker(cwd);
}

// ── In-chat opt-out phrase detection ──

// Only USER-role messages are scanned — the assistant merely discussing this
// feature ("you can say 'don't save this to engram'") must not trigger it.
// Three shapes, all requiring the word "engram" so ordinary "don't log this"
// chatter can't disable capture:
//   1. explicit marker:  engram:ignore | engram: off | engram skip
//   2. negation → verb → engram: "don't save this to engram",
//      "please do not sync this conversation to engram", "stop capturing to engram"
//   3. engram → negation → verb: "engram, don't record this",
//      "engram should not save this session"
const VERB = "(?:sav\\w*|record\\w*|captur\\w*|sync\\w*|remember\\w*|log\\w*|track\\w*|stor\\w*|upload\\w*)";
const NEG = "(?:don'?t|do\\s+not|please\\s+don'?t|please\\s+do\\s+not|stop|never|should\\s+not|shouldn'?t)";
const SPAN = "[^.!?\\n]{0,80}?";

const OPT_OUT_PATTERNS: RegExp[] = [
  /\bengram\s*[:,]?\s*(?:ignore|off|skip|exclude|opt[- ]?out)\b/i,
  new RegExp(`\\b${NEG}\\b${SPAN}\\b${VERB}\\b${SPAN}\\bengram\\b`, "i"),
  new RegExp(`\\bengram\\b${SPAN}\\b${NEG}\\b${SPAN}\\b${VERB}\\b`, "i"),
];

export function detectOptOut(content: string): boolean {
  // Transcript messages can be enormous (tool dumps); an opt-out is something
  // a person typed, so only scan a sane prefix.
  const head = content.length > 4096 ? content.slice(0, 4096) : content;
  return OPT_OUT_PATTERNS.some((re) => re.test(head));
}
