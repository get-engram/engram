import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectOptOut,
  isUnder,
  normalizeExcludePath,
  hasIgnoreMarker,
  isPathExcluded,
  resetExclusionCaches,
  IGNORE_MARKER,
} from "../daemon/exclusions.js";
import { DaemonDb } from "../daemon/db.js";

// Capture exclusions (engram#462). The opt-out phrase detector is the risky
// piece: a false negative quietly ignores a privacy request; a false positive
// silently disables capture. Pin both directions.

describe("detectOptOut", () => {
  const POSITIVE = [
    "don't save this to engram",
    "Don't save this conversation to Engram please",
    "do not save this session to engram",
    "please don't sync this to engram",
    "stop capturing this to engram",
    "never record this in engram",
    "don't log this chat to engram",
    "do not store this in engram",
    "don't upload this to engram",
    "engram: ignore",
    "engram:ignore",
    "engram off",
    "engram: opt-out",
    "engram, don't record this session",
    "engram should not save this",
    "engram shouldn't remember this conversation",
    "hey, quick thing — don't save this to engram, it's sensitive",
  ];
  for (const phrase of POSITIVE) {
    it(`triggers on: "${phrase}"`, () => {
      expect(detectOptOut(phrase)).toBe(true);
    });
  }

  const NEGATIVE = [
    // No negation — must NOT trigger.
    "save this to engram",
    "sync this conversation to engram please",
    // Negation + verb but no "engram" — ordinary chatter.
    "don't save this file yet",
    "do not log passwords",
    // "engram" present but negation applies to something else entirely
    // (different sentence — the span stops at sentence boundaries).
    "don't worry about the tests. engram is saving this fine",
    "I don't know. does engram save tool output?",
    // Talking ABOUT the feature.
    "how do I exclude a repo from engram?",
    "engram saves everything automatically",
    // Newline between negation and engram (span must not cross lines).
    "don't save this draft\nengram is great though",
  ];
  for (const phrase of NEGATIVE) {
    it(`does NOT trigger on: "${phrase}"`, () => {
      expect(detectOptOut(phrase)).toBe(false);
    });
  }

  it("only scans the first 4KB of huge tool dumps", () => {
    const huge = "x".repeat(5000) + " don't save this to engram";
    expect(detectOptOut(huge)).toBe(false);
    const early = "don't save this to engram " + "x".repeat(5000);
    expect(detectOptOut(early)).toBe(true);
  });
});

describe("path exclusion matching", () => {
  it("matches the directory itself and descendants, never sibling prefixes", () => {
    const excluded = normalizeExcludePath("/Users/x/code/secret");
    expect(isUnder("/Users/x/code/secret", excluded)).toBe(true);
    expect(isUnder("/Users/x/code/secret/sub/dir", excluded)).toBe(true);
    // The classic prefix bug: /code/secret must not match /code/secret2.
    expect(isUnder("/Users/x/code/secret2", excluded)).toBe(false);
    expect(isUnder("/Users/x/code", excluded)).toBe(false);
  });

  it("normalizes trailing separators", () => {
    expect(normalizeExcludePath("/a/b/")).toBe(normalizeExcludePath("/a/b"));
  });
});

describe(".engramignore markers + config integration", () => {
  let dir: string;

  beforeEach(() => {
    resetExclusionCaches();
    dir = mkdtempSync(join(tmpdir(), "engram-excl-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("finds a marker at the cwd and at an ancestor", () => {
    const repo = join(dir, "repo");
    const nested = join(repo, "src", "deep");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(repo, IGNORE_MARKER), "");
    expect(hasIgnoreMarker(nested)).toBe(true);
    expect(hasIgnoreMarker(repo)).toBe(true);
  });

  it("no marker → not excluded", () => {
    const clean = join(dir, "clean");
    mkdirSync(clean, { recursive: true });
    // NOTE: walks to the real filesystem root — a stray marker above tmpdir
    // would break this, which is itself worth knowing about.
    expect(hasIgnoreMarker(clean)).toBe(false);
  });

  it("isPathExcluded honors configured excludePaths (hot-reload via mtime)", () => {
    const repo = join(dir, "proj");
    mkdirSync(repo, { recursive: true });
    const cfg = join(dir, "config.json");

    writeFileSync(cfg, JSON.stringify({ excludePaths: [] }));
    expect(isPathExcluded(repo, cfg)).toBe(false);

    resetExclusionCaches(); // mtime granularity in CI can be coarse; force reload
    writeFileSync(cfg, JSON.stringify({ excludePaths: [repo] }));
    expect(isPathExcluded(repo, cfg)).toBe(true);
    expect(isPathExcluded(join(repo, "sub"), cfg)).toBe(true);
    expect(isPathExcluded(join(dir, "other"), cfg)).toBe(false);
  });

  it("undefined cwd is never excluded", () => {
    expect(isPathExcluded(undefined)).toBe(false);
  });
});

describe("DaemonDb excluded_sessions", () => {
  let dir: string;
  let db: DaemonDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engram-db-"));
    db = new DaemonDb(join(dir, "daemon.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("marks and reports excluded sessions", () => {
    expect(db.isSessionExcluded("s1")).toBe(false);
    db.markSessionExcluded("s1", "in-chat opt-out");
    expect(db.isSessionExcluded("s1")).toBe(true);
  });

  it("tracks and clears pending remote deletes", () => {
    db.markSessionExcluded("s2", "in-chat opt-out", "conv_abc");
    expect(db.getPendingRemoteDeletes()).toEqual([
      { session_id: "s2", delete_pending: "conv_abc" },
    ]);
    db.clearPendingRemoteDelete("s2");
    expect(db.getPendingRemoteDeletes()).toEqual([]);
    // Still excluded after the delete lands.
    expect(db.isSessionExcluded("s2")).toBe(true);
  });

  it("deleteAllForConversation removes queued rows (sent and unsent)", () => {
    db.enqueue("conv_x", [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
    expect(db.getPendingCount()).toBe(2);
    expect(db.deleteAllForConversation("conv_x")).toBe(2);
    expect(db.getPendingCount()).toBe(0);
  });
});
