import { vi } from "vitest";

// A failing assertion on a child_process mock prints every call it recorded
// (engram#728). The code under test gives a child this process's
// environment, and the shell that runs the tests can hold tokens and
// passwords for anything: one failure would print them to the terminal, a
// CI log, or a transcript. So a mock records no value from that
// environment.

/** What a recorded call holds in place of a value from the test's environment. */
export const FROM_TEST_ENV = "<from the test's environment>";

// The names this process had before its first test ran: the shell's.
const SHELL_NAMES = new Set(Object.keys(process.env));

/** A name the test's environment has, or had: its value is the shell's, or a test's own. */
function fromTestEnv(name: string): boolean {
  return SHELL_NAMES.has(name) || name in process.env;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * `arg` as a child_process mock records it: options with an `env` get a copy
 * of it with FROM_TEST_ENV for each value under a name the test's
 * environment has, or had, even one the code under test set itself. Every
 * name stays, and so does each value under a name of the code's own, such as
 * ENGRAM_IDENTIFY_PID, and each name the code takes away (undefined).
 * Anything else, and the options themselves, are left as they are.
 */
export function withoutEnvValues<T>(arg: T): T {
  if (!isPlainObject(arg) || typeof arg.env !== "object" || arg.env === null) return arg;
  const env = Object.fromEntries(
    Object.entries(arg.env).map(([name, value]) => [name, value !== undefined && fromTestEnv(name) ? FROM_TEST_ENV : value]),
  );
  return { ...arg, env } as T;
}

const RUNS_A_CHILD = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"];

// True of each mock recordingNoEnvValues hands out, and of no other.
const RECORDS_NO_ENV_VALUES = Symbol.for("engram#728: records no values from the test's environment");

function recordsNoEnvValues(fn: unknown): boolean {
  return (fn as Record<symbol, unknown>)[RECORDS_NO_ENV_VALUES] === true;
}

/**
 * A node:child_process mock's exports, with each mocked function among them
 * called with withoutEnvValues of its arguments: it records those, and its
 * implementation sees those. In every other way it is the mock: a test reads
 * `vi.mocked(spawn).mock.calls`, clears it or gives it an implementation as
 * it would the mock. A real function, spread from the actual module, is left
 * as it is: it never runs a child with the stand-ins.
 *
 *   vi.mock("node:child_process", async (importOriginal) =>
 *     (await import("./helpers/child-process.js")).recordingNoEnvValues({
 *       ...(await importOriginal<typeof import("node:child_process")>()),
 *       spawn,
 *     }),
 *   );
 */
export function recordingNoEnvValues<M extends object>(module: M): M {
  const exports = { ...module } as Record<string, unknown>;
  for (const name of RUNS_A_CHILD) {
    const fn = exports[name];
    if (!vi.isMockFunction(fn)) continue;
    exports[name] = new Proxy(fn as unknown as (...args: unknown[]) => unknown, {
      apply: (mock, thisArg, args: unknown[]) => Reflect.apply(mock, thisArg, args.map(withoutEnvValues)),
      get: (mock, key) => (key === RECORDS_NO_ENV_VALUES ? true : Reflect.get(mock, key)),
    });
  }
  return exports as M;
}

/**
 * Throws when a node:child_process module's exports hold a mock
 * recordingNoEnvValues didn't hand out: it records every call as it was
 * made, environment and all. Every test file is checked (setup/child-process-mocks.ts).
 */
export function checkChildProcessMocks(module: object): void {
  const exports = module as Record<string, unknown>;
  const unwrapped = RUNS_A_CHILD.filter((name) => vi.isMockFunction(exports[name]) && !recordsNoEnvValues(exports[name]));
  if (unwrapped.length === 0) return;
  throw new Error(
    `This file mocks node:child_process's ${unwrapped.join(", ")} as they are: a failing ` +
      "assertion on one would print the environment of the shell running the tests. " +
      'Return the mock through recordingNoEnvValues ("./helpers/child-process.js"), engram#728.',
  );
}
