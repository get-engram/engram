import * as childProcess from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkChildProcessMocks, FROM_TEST_ENV, recordingNoEnvValues } from "./helpers/child-process.js";

// A failing assertion on a child_process mock prints the calls it recorded,
// and the code under test gives a child this process's environment, which
// can hold the tokens and passwords of the shell running the tests
// (engram#728). So what a mock records holds none of its values.
//
// The values handed to the mocks here are made up, apart from the one test
// that hands over the whole environment and counts what is left, so that a
// failure here prints no real one either.

const PROBE = "ENGRAM_TEST_728_PROBE";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("recordingNoEnvValues (engram#728)", () => {
  it("records the code's own values, and none from the test's environment, under every name", () => {
    vi.stubEnv(PROBE, "probe value");
    vi.stubEnv("ENGRAM_TEST_728_TAKEN", "made-up value");
    const spawn = vi.fn();
    const options = {
      detached: true,
      env: {
        PATH: "made-up path",
        [PROBE]: "probe value",
        ENGRAM_TEST_728_SET: "set by the code",
        ENGRAM_TEST_728_UNSET: undefined,
        // Taken away from the child by the code: still so.
        ENGRAM_TEST_728_TAKEN: undefined,
      },
    };
    recordingNoEnvValues({ spawn }).spawn("node", ["worker.js"], options);
    expect(spawn.mock.calls).toEqual([
      [
        "node",
        ["worker.js"],
        {
          detached: true,
          env: {
            PATH: FROM_TEST_ENV,
            [PROBE]: FROM_TEST_ENV,
            ENGRAM_TEST_728_SET: "set by the code",
            ENGRAM_TEST_728_UNSET: undefined,
            ENGRAM_TEST_728_TAKEN: undefined,
          },
        },
      ],
    ]);
    // What the code passed is as it was.
    expect(options.env[PROBE]).toBe("probe value");
  });

  it("hides every value of the environment the code hands a child, and keeps its names", () => {
    vi.stubEnv(PROBE, "probe value");
    const execFileSync = vi.fn();
    const ran = recordingNoEnvValues({ execFileSync }).execFileSync;
    ran("powershell.exe", ["-Command", "x"], { env: { ...process.env, ENGRAM_IDENTIFY_PID: "4242" } });
    ran("powershell.exe", [], { env: process.env });
    const envs = execFileSync.mock.calls.map((call) => (call[2] as { env: Record<string, string | undefined> }).env);
    // Counted, not compared: a failure prints no value.
    const shown = envs.map((env) => Object.entries(env).filter(([name, value]) => name !== "ENGRAM_IDENTIFY_PID" && value !== FROM_TEST_ENV).length);
    expect(shown).toEqual([0, 0]);
    expect(envs[0].ENGRAM_IDENTIFY_PID).toBe("4242");
    expect(envs.map((env) => Object.keys(env).filter((name) => name !== "ENGRAM_IDENTIFY_PID").sort())).toEqual([
      Object.keys(process.env).sort(),
      Object.keys(process.env).sort(),
    ]);
    // process.env itself is left as it was.
    expect(process.env[PROBE]).toBe("probe value");
  });

  it("hides a value under a name the test's environment had, though a test has since taken it away", () => {
    // Set for every test file before its first mock is made (setup/config-home.ts).
    const name = "XDG_CONFIG_HOME";
    vi.stubEnv(name, undefined);
    expect(name in process.env).toBe(false);
    const spawn = vi.fn();
    recordingNoEnvValues({ spawn }).spawn("node", [], { env: { [name]: "made-up dir" } });
    expect(spawn.mock.calls[0][2]).toEqual({ env: { [name]: FROM_TEST_ENV } });
  });

  it("gives the mock's implementation the same, and returns what it returns", () => {
    vi.stubEnv(PROBE, "probe value");
    const seen: unknown[] = [];
    const execFile = vi.fn((_file: string, _args: string[], options: { env: Record<string, string> }) => {
      seen.push(options.env[PROBE]);
      return "from the mock";
    });
    expect(recordingNoEnvValues({ execFile }).execFile("x", [], { env: { [PROBE]: "probe value" } })).toBe("from the mock");
    expect(seen).toEqual([FROM_TEST_ENV]);
  });

  it("is, in every other way, the mock: what it recorded, its implementation, clearing it", () => {
    vi.stubEnv(PROBE, "probe value");
    const spawn = vi.fn();
    const wrapped = recordingNoEnvValues({ spawn }).spawn;
    expect(vi.isMockFunction(wrapped)).toBe(true);
    expect(vi.mocked(wrapped).mock).toBe(spawn.mock);
    vi.mocked(wrapped).mockReturnValue("from the mock");
    expect(wrapped("node", [], { env: { [PROBE]: "probe value" } })).toBe("from the mock");
    expect(wrapped).toHaveBeenCalledWith("node", [], { env: { [PROBE]: FROM_TEST_ENV } });
    vi.mocked(wrapped).mockClear();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("leaves options without an environment, and every other argument, as they are", () => {
    const execFile = vi.fn();
    const callback = () => {};
    const args = ["-a"];
    const options = { env: undefined, timeout: 1 };
    recordingNoEnvValues({ execFile }).execFile("x", args, options, callback);
    const [[, recordedArgs, recordedOptions, recordedCallback]] = execFile.mock.calls;
    expect(recordedArgs).toBe(args);
    expect(recordedOptions).toBe(options);
    expect(recordedCallback).toBe(callback);
  });

  it("leaves a real function as it is: it never runs a child with the stand-ins", () => {
    const mocked = recordingNoEnvValues({ ...childProcess, spawn: vi.fn() });
    expect(mocked.execFileSync).toBe(childProcess.execFileSync);
    expect(mocked.spawn).not.toBe(childProcess.spawn);
    expect(() => checkChildProcessMocks(mocked)).not.toThrow();
  });
});

describe("the check of every test file's child_process mocks (engram#728)", () => {
  it("names each mock left as it is, and passes once recordingNoEnvValues has them", () => {
    const fake = { spawn: vi.fn(), execFileSync: vi.fn(), execFile: () => {}, other: vi.fn() };
    expect(() => checkChildProcessMocks(fake)).toThrow("mocks node:child_process's spawn, execFileSync as they are");
    expect(() => checkChildProcessMocks(recordingNoEnvValues(fake))).not.toThrow();
    expect(() => checkChildProcessMocks(childProcess)).not.toThrow();
  });

  it("runs for every test file", () => {
    const config = readFileSync(new URL("../../vitest.config.ts", import.meta.url), "utf-8");
    expect(config).toMatch(/setupFiles: \[[^\]]*"\.\/src\/__tests__\/setup\/child-process-mocks\.ts"/);
  });
});
