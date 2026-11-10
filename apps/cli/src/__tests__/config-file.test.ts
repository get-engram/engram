import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigUnreadable,
  excludePathsOf,
  isMissing,
  parseConfigText,
  readConfigFileSync,
  readFailure,
  readProblem,
  unreadable,
  writeProblem,
} from "../config-file.js";

// engram#673: ~/.engram/config.json holds the API key and the folders kept
// out of capture. One that is there but can't be read, or doesn't hold
// settings, used to read as no settings: the daemon captured excluded
// folders, and a command that saved the file replaced the key and the
// exclusions. Now it is a ConfigUnreadable, whose message says what is
// wrong without quoting the file.

const { home } = vi.hoisted(() => ({ home: { dir: "" } }));

// config.ts keeps its file in ~/.engram: a temp home.
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));

home.dir = mkdtempSync(join(tmpdir(), "engram-673-config-"));
const ENGRAM = join(home.dir, ".engram");
const CONFIG = join(ENGRAM, "config.json");
afterAll(() => rmSync(home.dir, { recursive: true, force: true }));

// After the temp home is set: config.ts takes its path from it when imported.
const { loadConfigStrict } = await import("../config.js");

const win32 = process.platform === "win32";
const root = process.geteuid?.() === 0;

/** The end of a made-up key: what must never reach a message. */
const TAIL = "Q9Z7LEAK";
const KEY = `engram_sk_live_test_673_${TAIL}`;

const errno = (code: string, message = `${code}: injected`) => Object.assign(new Error(message), { code });

function caught(fn: () => unknown): ConfigUnreadable {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigUnreadable) return err;
    throw err;
  }
  throw new Error("it didn't throw");
}

async function rejected(promise: Promise<unknown>): Promise<ConfigUnreadable> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ConfigUnreadable) return err;
    throw err;
  }
  throw new Error("it didn't reject");
}

describe("parseConfigText", () => {
  it("reads settings", () => {
    expect(parseConfigText(`{"apiKey": "${KEY}", "excludePaths": ["/a"]}`)).toEqual({
      apiKey: KEY,
      excludePaths: ["/a"],
    });
  });

  it("skips the byte-order mark some Windows editors add", () => {
    expect(parseConfigText('\uFEFF{"autocapture": "off"}\n')).toEqual({ autocapture: "off" });
  });

  it.each(["", " \n\t", "\uFEFF", "\uFEFF \r\n"])("calls %j empty", (text) => {
    const err = caught(() => parseConfigText(text));
    expect(err.message).toBe("~/.engram/config.json is empty");
    expect(err.problem).toBe("is empty");
    expect(err.empty).toBe(true);
  });

  it("says a file cut short isn't valid JSON", () => {
    const err = caught(() => parseConfigText(`{"apiKey": "${KEY}", "excludePa`));
    expect(err.message).toBe("~/.engram/config.json isn't valid JSON");
    expect(err.problem).toBe("isn't valid JSON");
    expect(err.empty).toBe(false);
  });

  it.each(["[]", '[{"apiKey": "k"}]', "null", "42", '"settings"', "true"])("says %s isn't settings", (text) => {
    const err = caught(() => parseConfigText(text));
    expect(err.message).toBe("~/.engram/config.json isn't a JSON object");
    expect(err.empty).toBe(false);
  });

  // The daemon logs why it holds, and puts it in status.json and a
  // notification, so the reason must not be JSON.parse's own message.
  it("never quotes the file, as JSON.parse's own message does", () => {
    // A value typed without quotes after the key, in a file edited by hand.
    const text = `{"apiKey":"${KEY}","n":x}`;
    let native = "";
    try {
      JSON.parse(text);
    } catch (err) {
      native = (err as Error).message;
    }
    // V8 quotes the text around the error: here, the end of the key.
    expect(native).toContain(TAIL.slice(-4));

    const err = caught(() => parseConfigText(text));
    expect(err.message).toBe("~/.engram/config.json isn't valid JSON");
    expect(err.cause).toBeUndefined();
    for (const said of [err.message, String(err), err.stack ?? ""]) {
      expect(said).not.toContain(TAIL.slice(-4));
      expect(said).not.toContain("engram_sk_");
    }
  });
});

describe("excludePathsOf", () => {
  it.each([{}, { excludePaths: null }, { excludePaths: [] }])("finds none in %j", (config) => {
    expect(excludePathsOf(config)).toEqual([]);
  });

  it("returns the paths as saved", () => {
    expect(excludePathsOf({ excludePaths: ["/a", "~/b", "C:\\c"] })).toEqual(["/a", "~/b", "C:\\c"]);
  });

  // Which folders are excluded can't be told from any of these, so the
  // daemon must not take them for none.
  it.each([
    { excludePaths: "/a" },
    { excludePaths: ["/a", 3] },
    { excludePaths: [null] },
    { excludePaths: { 0: "/a" } },
    { excludePaths: true },
  ])("refuses %j", (config) => {
    const err = caught(() => excludePathsOf(config));
    expect(err.message).toBe("~/.engram/config.json has an excludePaths that isn't a list of paths");
    expect(err.empty).toBe(false);
  });
});

describe("why a read failed", () => {
  it.each([
    ["EACCES", "can't be read: permission denied"],
    ["EPERM", "can't be read: permission denied"],
    ["EISDIR", "is a folder, not a file"],
    ["EIO", "can't be read (EIO)"],
    ["EMFILE", "can't be read (EMFILE)"],
  ])("names %s from its code", (code, problem) => {
    const err = unreadable(errno(code));
    expect(err).toBeInstanceOf(ConfigUnreadable);
    expect(err.message).toBe(`~/.engram/config.json ${problem}`);
    expect(err.empty).toBe(false);
  });

  it("takes nothing from an error's message, or from a code that isn't one", () => {
    const secret = `open '/Users/someone/${TAIL}'`;
    for (const err of [
      new Error(secret),
      errno(`bad ${TAIL}`, secret),
      errno("eacces", secret),
      null,
      undefined,
      secret,
    ]) {
      const said = unreadable(err);
      expect(said.message).toBe("~/.engram/config.json can't be read");
      expect(said.stack).not.toContain(TAIL);
      expect(said.cause).toBeUndefined();
    }
  });

  it("takes ENOENT on a file that is there for a link to nothing", () => {
    expect(readFailure(errno("ENOENT")).message).toBe("~/.engram/config.json is a link to a file that isn't there");
    expect(readFailure(errno("EACCES")).message).toBe("~/.engram/config.json can't be read: permission denied");
  });

  it("readProblem: the same words, for any file's name to go before (engram#677)", () => {
    expect(readProblem(errno("ENOENT"))).toBe("is a link to a file that isn't there");
    expect(readProblem(errno("EACCES"))).toBe("can't be read: permission denied");
    expect(readProblem(errno("EISDIR"))).toBe("is a folder, not a file");
    expect(readProblem(errno("EIO"))).toBe("can't be read (EIO)");
    expect(readProblem(new Error(`open '/Users/someone/${TAIL}'`))).toBe("can't be read");
    expect(readProblem(errno(`bad ${TAIL}`))).toBe("can't be read");
  });
});

describe("why a write failed (engram#681)", () => {
  it.each([
    ["EACCES", "can't be written: permission denied"],
    ["EPERM", "can't be written: permission denied"],
    ["EROFS", "can't be written: the disk it's on is read-only"],
    ["ENOSPC", "can't be written: the disk it's on is full"],
    ["EDQUOT", "can't be written: the disk quota is used up"],
    ["EIO", "can't be written (EIO)"],
    ["EBUSY", "can't be written (EBUSY)"],
  ])("names %s from its code", (code, problem) => {
    expect(writeProblem(errno(code))).toBe(problem);
  });

  it("takes nothing from an error's message, or from a code that isn't one", () => {
    const secret = `open '/Users/someone/${TAIL}'`;
    for (const err of [new Error(secret), errno(`bad ${TAIL}`, secret), errno("eacces", secret), null, undefined, secret]) {
      expect(writeProblem(err)).toBe("can't be written");
    }
  });
});

describe("readConfigFileSync", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(home.dir, "read-"));
  });

  it("finds no settings when there is no file", () => {
    expect(readConfigFileSync(join(dir, "config.json"))).toBeNull();
    expect(isMissing(errno("ENOENT"), join(dir, "config.json"))).toBe(true);
  });

  it("reads one", () => {
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ apiKey: KEY, excludePaths: ["/a"] }));
    expect(readConfigFileSync(file)).toEqual({ apiKey: KEY, excludePaths: ["/a"] });
  });

  it("refuses a folder", () => {
    const file = join(dir, "config.json");
    mkdirSync(file);
    expect(caught(() => readConfigFileSync(file)).message).toBe("~/.engram/config.json is a folder, not a file");
    expect(isMissing(errno("ENOENT"), file)).toBe(false);
  });

  it("refuses a file that isn't settings", () => {
    const file = join(dir, "config.json");
    writeFileSync(file, `{"apiKey": "${KEY}",`);
    expect(caught(() => readConfigFileSync(file)).message).toBe("~/.engram/config.json isn't valid JSON");
  });

  // A config.json linked from a volume that isn't mounted is settings that
  // can't be reached, not no settings.
  it.skipIf(win32)("refuses a link to a file that isn't there", () => {
    const file = join(dir, "config.json");
    symlinkSync(join(dir, "elsewhere", "config.json"), file);
    expect(isMissing(errno("ENOENT"), file)).toBe(false);
    expect(caught(() => readConfigFileSync(file)).message).toBe(
      "~/.engram/config.json is a link to a file that isn't there",
    );
  });

  it.skipIf(win32)("follows a link to a file that is there", () => {
    const real = join(dir, "real.json");
    writeFileSync(real, JSON.stringify({ excludePaths: ["/a"] }));
    const file = join(dir, "config.json");
    symlinkSync(real, file);
    expect(readConfigFileSync(file)).toEqual({ excludePaths: ["/a"] });
  });

  it.skipIf(win32 || root)("refuses a file it can't read", () => {
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ apiKey: KEY }));
    chmodSync(file, 0o000);
    try {
      expect(caught(() => readConfigFileSync(file)).message).toBe(
        "~/.engram/config.json can't be read: permission denied",
      );
    } finally {
      chmodSync(file, 0o600);
    }
  });
});

describe("loadConfigStrict", () => {
  beforeEach(() => {
    rmSync(ENGRAM, { recursive: true, force: true });
    mkdirSync(ENGRAM, { recursive: true });
  });

  it("finds no settings when there is no config.json", async () => {
    await expect(loadConfigStrict()).resolves.toEqual({});
  });

  it("reads the settings", async () => {
    writeFileSync(CONFIG, JSON.stringify({ apiKey: KEY, excludePaths: ["/a"] }));
    await expect(loadConfigStrict()).resolves.toEqual({ apiKey: KEY, excludePaths: ["/a"] });
  });

  it.each([
    [`{"apiKey": "${KEY}", "excludePa`, "isn't valid JSON", false],
    ["", "is empty", true],
    ["[]", "isn't a JSON object", false],
  ])("refuses %j: it %s", async (text, problem, empty) => {
    writeFileSync(CONFIG, text);
    const err = await rejected(loadConfigStrict());
    expect(err.problem).toBe(problem);
    expect(err.empty).toBe(empty);
    expect(err.message).not.toContain(TAIL);
  });

  it("refuses a folder", async () => {
    mkdirSync(CONFIG);
    expect((await rejected(loadConfigStrict())).message).toBe("~/.engram/config.json is a folder, not a file");
  });

  it.skipIf(win32)("refuses a link to a file that isn't there", async () => {
    symlinkSync(join(home.dir, "unmounted", "config.json"), CONFIG);
    expect((await rejected(loadConfigStrict())).message).toBe(
      "~/.engram/config.json is a link to a file that isn't there",
    );
  });
});
