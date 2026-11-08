import { statSync, existsSync, readFileSync, realpathSync } from "node:fs";
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

// One directory has many spellings, and an exclusion has to match them all
// (engram#619). File systems on macOS and Windows ignore case by default, so
// ~/Code/Client is ~/code/client and C:\work is c:\work; macOS also ignores
// Unicode normalization (é typed as one code point or as e + accent).
// Matching too much on a case-sensitive volume only keeps more out of
// capture, which is the safe side of this check.

/** The form a path is compared in on `platform`. */
export function foldPath(p: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" || platform === "win32"
    ? p.normalize("NFC").toLowerCase()
    : p;
}

/** True when `a` and `b` spell the same path on `platform`. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return foldPath(normalizeExcludePath(a), platform) === foldPath(normalizeExcludePath(b), platform);
}

/**
 * `p` as given and, when it differs, with symlinks resolved. Agents record
 * the resolved directory, while an exclusion is often typed through a link:
 * a ~/code that points at another volume, or /tmp, which on macOS is
 * /private/tmp. A path that doesn't exist (yet) has only the first form.
 */
function spellings(p: string): string[] {
  try {
    const real = normalizeExcludePath(realpathSync.native(p));
    return real === p ? [p] : [p, real];
  } catch {
    return [p];
  }
}

/** Every excluded path, each as configured and with symlinks resolved. */
export function loadExcludePaths(configFile: string = CONFIG_FILE): string[] {
  try {
    const mtimeMs = statSync(configFile).mtimeMs;
    if (mtimeMs !== cachedMtimeMs) {
      const raw = JSON.parse(readFileSync(configFile, "utf-8")) as {
        excludePaths?: string[];
      };
      cachedPaths = (raw.excludePaths ?? []).flatMap((p) => spellings(normalizeExcludePath(p)));
      cachedMtimeMs = mtimeMs;
    }
  } catch {
    cachedPaths = [];
    cachedMtimeMs = -1;
  }
  return cachedPaths;
}

/** True when `cwd` is at or under `excluded` (never a sibling-prefix match:
 *  /a/repo does NOT match /a/repo2), in `platform`'s idea of case. */
export function isUnder(
  cwd: string,
  excluded: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const c = foldPath(normalizeExcludePath(cwd), platform);
  const e = foldPath(excluded, platform);
  return c === e || c.startsWith(e + sep);
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
  if (paths.length > 0) {
    const dirs = spellings(normalizeExcludePath(cwd));
    if (paths.some((p) => dirs.some((d) => isUnder(d, p)))) return true;
  }
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
