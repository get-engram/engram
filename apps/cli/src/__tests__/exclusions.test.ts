import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectOptOut,
  isUnder,
  normalizeExcludePath,
  hasIgnoreMarker,
  isPathExcluded,
  resetExclusionCaches,
  samePath,
  IGNORE_MARKER,
} from "../daemon/exclusions.js";
import Database from "better-sqlite3";
import { DaemonDb } from "../daemon/db.js";
import { ExclusionsUnreadable, QueueWriteError, isCaptureHold, queueing } from "../daemon/queue-error.js";

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

  // engram#619: an exclusion typed as ~/Code/Client let sessions recorded in
  // ~/code/client through, though on macOS and Windows they're one directory.
  it("ignores case and Unicode normalization on macOS and Windows, not on Linux", () => {
    const excluded = normalizeExcludePath("/Users/x/Code/Client");
    for (const platform of ["darwin", "win32"] as const) {
      expect(isUnder("/Users/x/code/client/src", excluded, platform), platform).toBe(true);
      expect(isUnder("/users/X/CODE/CLIENT", excluded, platform), platform).toBe(true);
      expect(isUnder("/Users/x/code/client2", excluded, platform), platform).toBe(false);
    }
    expect(isUnder("/Users/x/code/client", excluded, "linux")).toBe(false);
    expect(isUnder("/Users/x/Code/Client/src", excluded, "linux")).toBe(true);

    // é as one code point, then as e + a combining accent.
    const cafe = normalizeExcludePath("/Users/x/caf\u00e9");
    expect(isUnder("/Users/x/cafe\u0301/notes", cafe, "darwin")).toBe(true);
  });

  it("samePath follows the platform's rules", () => {
    expect(samePath("/a/Repo", "/a/repo", "darwin")).toBe(true);
    expect(samePath("/a/Repo/", "/a/repo", "win32")).toBe(true);
    expect(samePath("/a/Repo", "/a/repo", "linux")).toBe(false);
    expect(samePath("/a/repo/", "/a/repo", "linux")).toBe(true);
  });

  it.runIf(process.platform === "win32")("treats C:\\ and c:\\ as one drive", () => {
    expect(isUnder("C:\\work\\client\\src", normalizeExcludePath("c:\\Work\\Client"))).toBe(true);
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

  // engram#619: agents record the directory with symlinks resolved, and
  // people often type the path through a link (or the other way round).
  it("matches an exclusion typed through a symlink, and the reverse", () => {
    const real = join(dir, "real");
    mkdirSync(join(real, "sub"), { recursive: true });
    const link = join(dir, "link");
    symlinkSync(real, link, "junction"); // a junction needs no admin rights on Windows
    const cfg = join(dir, "config.json");

    writeFileSync(cfg, JSON.stringify({ excludePaths: [link] }));
    resetExclusionCaches();
    expect(isPathExcluded(join(realpathSync.native(real), "sub"), cfg)).toBe(true);

    writeFileSync(cfg, JSON.stringify({ excludePaths: [real] }));
    resetExclusionCaches();
    expect(isPathExcluded(join(link, "sub"), cfg)).toBe(true);

    // A sibling of the target stays captured.
    mkdirSync(join(dir, "other"), { recursive: true });
    expect(isPathExcluded(join(dir, "other"), cfg)).toBe(false);
  });

  it("undefined cwd is never excluded", () => {
    expect(isPathExcluded(undefined)).toBe(false);
  });
});

// engram#673: a config.json that is there but can't be read, or doesn't
// hold settings, read as no exclusions, and every session was captured,
// excluded or not. Now whether a folder is excluded can't be told, and the
// watcher holds the transcript until it can.
describe("config.json that can't be read (engram#673)", () => {
  /** The end of a made-up key: what must never reach a message. */
  const TAIL = "Q9Z7LEAK";
  let dir: string;
  let repo: string;
  let cfg: string;

  beforeEach(() => {
    resetExclusionCaches();
    dir = mkdtempSync(join(tmpdir(), "engram-673-excl-"));
    repo = join(dir, "repo");
    mkdirSync(repo, { recursive: true });
    cfg = join(dir, "config.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function cantTell(cwd: string = repo): ExclusionsUnreadable {
    try {
      isPathExcluded(cwd, cfg);
    } catch (err) {
      if (err instanceof ExclusionsUnreadable) return err;
      throw err;
    }
    throw new Error("it didn't throw");
  }

  it("can't tell whether a folder is excluded when config.json isn't JSON", () => {
    writeFileSync(cfg, `{"apiKey":"engram_sk_live_test_673_${TAIL}","n":x}`);
    const err = cantTell();
    expect(err.reason).toBe("~/.engram/config.json isn't valid JSON");
    expect(err.message).toBe(
      "can't tell which folders are excluded from capture: ~/.engram/config.json isn't valid JSON",
    );
    expect(err.kind).toBe("config");
    expect(isCaptureHold(err)).toBe(true);
    expect(err.cause).toBeUndefined();
    expect(`${err.stack}`).not.toContain(TAIL.slice(-4));
  });

  it.each([
    ["", "~/.engram/config.json is empty"],
    ['{"excludePaths": "/x"}', "~/.engram/config.json has an excludePaths that isn't a list of paths"],
    ['{"excludePaths": ["/x", 1]}', "~/.engram/config.json has an excludePaths that isn't a list of paths"],
    ["[]", "~/.engram/config.json isn't a JSON object"],
  ])("can't tell from %j", (text, reason) => {
    writeFileSync(cfg, text);
    expect(cantTell().reason).toBe(reason);
  });

  it("can't tell from a folder", () => {
    mkdirSync(cfg);
    expect(cantTell().reason).toBe("~/.engram/config.json is a folder, not a file");
  });

  it.skipIf(process.platform === "win32")("can't tell from a link to a file that isn't there", () => {
    symlinkSync(join(dir, "unmounted", "config.json"), cfg);
    expect(cantTell().reason).toBe("~/.engram/config.json is a link to a file that isn't there");
  });

  it("still excludes a folder with a marker", () => {
    writeFileSync(cfg, "{");
    writeFileSync(join(repo, IGNORE_MARKER), "");
    expect(isPathExcluded(join(repo, "src"), cfg)).toBe(true);
  });

  it("still captures a session with no working directory, which no folder excludes", () => {
    writeFileSync(cfg, "{");
    expect(isPathExcluded(undefined, cfg)).toBe(false);
  });

  it("finds none when there is no config.json", () => {
    expect(isPathExcluded(repo, cfg)).toBe(false);
  });

  it("doesn't fall back on what it read before, and honours the file once fixed", () => {
    writeFileSync(cfg, JSON.stringify({ excludePaths: [] }));
    expect(isPathExcluded(repo, cfg)).toBe(false);

    // Damaged in place, at a different size, so a coarse mtime can't hide it.
    writeFileSync(cfg, '{"excludePaths": [');
    expect(cantTell().reason).toBe("~/.engram/config.json isn't valid JSON");
    // Nothing from the failure is kept.
    expect(cantTell().reason).toBe("~/.engram/config.json isn't valid JSON");

    writeFileSync(cfg, JSON.stringify({ excludePaths: [repo] }));
    expect(isPathExcluded(join(repo, "sub"), cfg)).toBe(true);
    expect(isPathExcluded(join(dir, "other"), cfg)).toBe(false);
  });

  it("stays a config.json hold if a daemon.db step runs into it", () => {
    // Said as a daemon.db failure, it would send the user after the disk.
    writeFileSync(cfg, "{");
    const hold = cantTell();
    let thrown: unknown;
    try {
      queueing(() => {
        throw hold;
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBe(hold);
    // A daemon.db failure is still one (engram#584).
    expect(() =>
      queueing(() => {
        throw new Error("database or disk is full");
      }),
    ).toThrow(QueueWriteError);
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

  /** Rows daemon.db has for `conversationId`, sent or not (getPendingCount
   *  counts only the unsent ones). */
  function rowsFor(conversationId: string): number {
    const raw = new Database(join(dir, "daemon.db"), { readonly: true });
    try {
      return (
        raw
          .prepare("SELECT COUNT(*) AS c FROM pending_messages WHERE conversation_id = ?")
          .get(conversationId) as { c: number }
      ).c;
    } finally {
      raw.close();
    }
  }

  it("marks and reports excluded sessions", () => {
    expect(db.isSessionExcluded("s1")).toBe(false);
    db.markSessionExcluded("s1", "in-chat opt-out");
    expect(db.isSessionExcluded("s1")).toBe(true);
  });

  it("tracks and clears pending remote deletes, each under its account's key (engram#594)", () => {
    // One session synced under two accounts' keys has a conversation in each.
    db.setSessionMap("s2", "conv_abc", { projectDir: "p" }, "fp-a");
    db.setSessionMap("s2", "conv_def", { projectDir: "p" }, "fp-b");
    expect(db.excludeSession("s2", "in-chat opt-out").conversations).toEqual([
      { conversationId: "conv_abc", keyFp: "fp-a" },
      { conversationId: "conv_def", keyFp: "fp-b" },
    ]);
    // Each delete is sent only with its own account's key.
    expect(db.getPendingRemoteDeletes("fp-a")).toEqual([
      { conversation_id: "conv_abc", session_id: "s2" },
    ]);
    expect(db.getPendingRemoteDeletes("fp-b")).toEqual([
      { conversation_id: "conv_def", session_id: "s2" },
    ]);
    db.clearPendingRemoteDelete("conv_abc");
    expect(db.getPendingRemoteDeletes("fp-a")).toEqual([]);
    expect(db.getPendingRemoteDeletes("fp-b")).toHaveLength(1);
    // Still excluded after the delete lands.
    expect(db.isSessionExcluded("s2")).toBe(true);
  });

  it("deleteAllForConversation removes every row and counts only the unsent ones (engram#628)", () => {
    db.enqueue("conv_x", [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ], null);
    // Two went out before the opt-out. Their rows are only this machine's
    // record of messages the server already has, not messages dropped.
    const sent = db.dequeue("conv_x", 2, null);
    expect(sent).toHaveLength(2);
    db.markSent(sent.map((r) => r.id));
    expect(rowsFor("conv_x")).toBe(3);

    expect(db.deleteAllForConversation("conv_x")).toBe(1);
    expect(rowsFor("conv_x")).toBe(0);
    expect(db.getPendingCount()).toBe(0);

    // Everything sent already: nothing was dropped, though rows were deleted.
    db.enqueue("conv_y", [{ role: "user", content: "d" }], null);
    db.markSent(db.dequeue("conv_y", 10, null).map((r) => r.id));
    expect(db.deleteAllForConversation("conv_y")).toBe(0);
    expect(rowsFor("conv_y")).toBe(0);
  });

  it("excludeSession counts only the dropped messages that were never sent (engram#628)", () => {
    db.setSessionMap("s3", "conv_s3", { projectDir: "p" }, "fp-a");
    db.enqueue("conv_s3", [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ], "fp-a");
    db.markSent(db.dequeue("conv_s3", 10, "fp-a").map((r) => r.id));
    db.enqueue("conv_s3", [{ role: "user", content: "c" }], "fp-a");
    // Under another key, the session has no conversation yet.
    db.enqueuePendingSession(
      "s3",
      { sessionId: "s3", projectDir: "p" },
      [{ role: "user", content: "d" }],
      "fp-b",
    );

    const { conversations, dropped } = db.excludeSession("s3", "in-chat opt-out");
    expect(conversations).toEqual([{ conversationId: "conv_s3", keyFp: "fp-a" }]);
    expect(dropped).toBe(2); // "c" and "d"; "a" and "b" had been sent
    expect(rowsFor("conv_s3")).toBe(0);
    expect(rowsFor("pending:s3")).toBe(0);
    expect(db.isSessionExcluded("s3")).toBe(true);
  });
});
