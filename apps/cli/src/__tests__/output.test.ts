import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bold, colorEnabled, cyan, dim, green, plural, red } from "../output.js";

// CLI output (engram#628): colors only on a terminal and never with
// NO_COLOR, and counts that agree with their nouns.

const ESC = "\x1b[";
const streams = [process.stdout, process.stderr] as const;

describe("colors", () => {
  let saved: Array<PropertyDescriptor | undefined>;

  function terminals(stdout: boolean | undefined, stderr: boolean | undefined): void {
    Object.defineProperty(process.stdout, "isTTY", { value: stdout, configurable: true, writable: true });
    Object.defineProperty(process.stderr, "isTTY", { value: stderr, configurable: true, writable: true });
  }

  /** Every helper's output, and whether any of it has an escape code. */
  function painted(): boolean {
    const out = [dim("x"), bold("x"), green("x"), red("x"), cyan("x")];
    const anyEscape = out.some((s) => s.includes(ESC));
    if (!anyEscape) expect(out).toEqual(["x", "x", "x", "x", "x"]);
    return anyEscape;
  }

  beforeEach(() => {
    saved = streams.map((s) => Object.getOwnPropertyDescriptor(s, "isTTY"));
    // The environment the tests run in mustn't decide the outcome.
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("TERM", "xterm-256color");
  });

  afterEach(() => {
    streams.forEach((s, i) => {
      const d = saved[i];
      if (d) Object.defineProperty(s, "isTTY", d);
      else delete (s as { isTTY?: boolean }).isTTY;
    });
    vi.unstubAllEnvs();
  });

  it("are on when stdout and stderr are both terminals", () => {
    terminals(true, true);
    expect(colorEnabled()).toBe(true);
    expect(painted()).toBe(true);
    expect(green("ok")).toBe("\x1b[32mok\x1b[0m");
    expect(dim("ok")).toBe("\x1b[2mok\x1b[0m");
  });

  it("are off when stdout isn't a terminal (a pipe, a file)", () => {
    terminals(false, true);
    expect(colorEnabled()).toBe(false);
    expect(painted()).toBe(false);
  });

  it("are off when stderr isn't a terminal (2> log)", () => {
    terminals(true, false);
    expect(colorEnabled()).toBe(false);
    expect(painted()).toBe(false);
  });

  it("are off when isTTY is undefined, as on a stream that isn't a tty at all", () => {
    terminals(undefined, undefined);
    expect(colorEnabled()).toBe(false);
    expect(painted()).toBe(false);
    terminals(true, undefined);
    expect(colorEnabled()).toBe(false);
  });

  it("are off with NO_COLOR set to any non-empty value, on a terminal too", () => {
    terminals(true, true);
    for (const value of ["1", "true", "0", "no"]) {
      vi.stubEnv("NO_COLOR", value);
      expect(colorEnabled()).toBe(false);
      expect(painted()).toBe(false);
    }
  });

  it("stay on with NO_COLOR set to the empty string (no-color.org)", () => {
    terminals(true, true);
    vi.stubEnv("NO_COLOR", "");
    expect(colorEnabled()).toBe(true);
    expect(painted()).toBe(true);
  });

  it("are off on a terminal that can't show them (TERM=dumb)", () => {
    terminals(true, true);
    vi.stubEnv("TERM", "dumb");
    expect(colorEnabled()).toBe(false);
    expect(painted()).toBe(false);
  });

  it("follow a change made after the module loaded", () => {
    terminals(true, true);
    expect(painted()).toBe(true);
    vi.stubEnv("NO_COLOR", "1");
    expect(painted()).toBe(false);
    vi.stubEnv("NO_COLOR", undefined);
    terminals(false, false);
    expect(painted()).toBe(false);
  });
});

describe("plural", () => {
  it("is singular for exactly one and plural otherwise", () => {
    expect(plural(1, "message")).toBe("1 message");
    expect(plural(0, "message")).toBe("0 messages");
    expect(plural(2, "message")).toBe("2 messages");
    expect(plural(-1, "message")).toBe("-1 messages");
    expect(plural(1.5, "message")).toBe("1.5 messages");
  });

  it("groups thousands the same way on every machine", () => {
    expect(plural(1234, "message")).toBe("1,234 messages");
    expect(plural(1_000_000, "conversation")).toBe("1,000,000 conversations");
  });

  it("takes the plural for a noun that doesn't just add an s", () => {
    expect(plural(1, "copy", "copies")).toBe("1 copy");
    expect(plural(3, "copy", "copies")).toBe("3 copies");
    expect(plural(1, "queued message")).toBe("1 queued message");
    expect(plural(4, "queued message")).toBe("4 queued messages");
  });

  it("prints a count that isn't a number as it is, instead of throwing", () => {
    expect(plural(undefined as unknown as number, "message")).toBe("undefined messages");
    expect(plural(NaN, "message")).toBe("NaN messages");
    expect(plural(Infinity, "message")).toBe("Infinity messages");
  });
});
