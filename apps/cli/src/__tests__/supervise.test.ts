import { afterEach, describe, it, expect, vi } from "vitest";
import {
  FIRST_DELAY_MS,
  MAX_DELAY_MS,
  MAX_FAILURES,
  POLL_MS,
  STABLE_MS,
  START_FAILED_EXIT,
  reportUntilArg,
  supervise,
  type SuperviseDeps,
  type SuperviseOptions,
} from "../daemon/supervise.js";

/**
 * engram#613 — the Windows daemon's supervisor, on a clock of its own: no
 * process, file or timer is real here. Each worker it starts is the next
 * entry of `workers`: it runs for `runsFor` ms of that clock, and exits
 * with `code` (or throws `throws`, as a start that failed outright). `at`
 * runs on that clock too: `engram stop` writing the stop file, or another
 * daemon starting.
 */
interface Worker {
  code: number | null;
  runsFor?: number;
  throws?: string;
  /** While it runs, after `runsFor`: what happens as it exits. */
  onExit?: () => void;
}

function harness(workers: Worker[], options: { reportUntil?: number; command?: (rest: string) => string } = {}) {
  const state = {
    t: 1_000_000,
    stamp: null as string | null,
    stamps: 0,
    running: false,
    started: [] as number[],
    sleeps: [] as number[],
    removed: [] as string[],
    logs: [] as string[],
    at: [] as Array<{ t: number; run: () => void }>,
  };
  const advance = (ms: number): void => {
    const until = state.t + ms;
    for (;;) {
      const next = state.at.filter((e) => e.t <= until).sort((a, b) => a.t - b.t)[0];
      if (!next) break;
      state.at.splice(state.at.indexOf(next), 1);
      state.t = Math.max(state.t, next.t);
      next.run();
    }
    state.t = until;
  };
  const deps: SuperviseDeps = {
    async start() {
      const worker = workers.shift();
      if (!worker) throw new Error("the test started more workers than it scripted");
      state.started.push(state.t);
      if (worker.throws) throw new Error(worker.throws);
      advance(worker.runsFor ?? 0);
      worker.onExit?.();
      return worker.code;
    },
    async running() {
      return state.running;
    },
    stopStamp: () => state.stamp,
    removeStop(stamp) {
      state.removed.push(stamp);
      if (state.stamp === stamp) state.stamp = null;
    },
    async sleep(ms) {
      state.sleeps.push(ms);
      advance(ms);
    },
    now: () => state.t,
    log: (msg) => state.logs.push(msg),
  };
  /** `engram stop` writes a request: a new stamp. */
  const stop = (): void => {
    state.stamps += 1;
    state.stamp = `stamp-${state.stamps}`;
  };
  const run = () =>
    supervise(deps, {
      reportUntil: options.reportUntil ?? 0,
      // As the installed CLI names it.
      command: options.command ?? ((rest) => `engram ${rest}`),
    });
  return { state, stop, run };
}

/** The waits between starts: the gaps the sleeps add up to, one per restart. */
function waits(state: { started: number[] }, runsFor = 0): number[] {
  return state.started.slice(1).map((t, i) => t - state.started[i] - runsFor);
}

describe("the Windows daemon's supervisor (engram#613)", () => {
  it("doesn't start a worker again that exits 0: it was stopped, or found another daemon", async () => {
    const h = harness([{ code: 0, runsFor: 60_000 }]);
    expect(await h.run()).toBe(0);
    expect(h.state.started).toHaveLength(1);
    expect(h.state.sleeps).toEqual([]);
  });

  it("starts a worker again after an error, waiting longer each time, up to 5 minutes", async () => {
    const h = harness([
      ...Array.from({ length: 7 }, () => ({ code: 1, runsFor: 1_000 })),
      { code: 0, runsFor: 1_000 },
    ]);
    expect(await h.run()).toBe(0);
    expect(h.state.started).toHaveLength(8);
    expect(waits(h.state, 1_000)).toEqual([10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
    expect(MAX_DELAY_MS).toBe(300_000);
    expect(h.state.logs[0]).toBe("the daemon exited with code 1; starting it again in 10s");
    expect(h.state.logs).toContain("the daemon exited with code 1; starting it again in 300s");
    // It looks for a stop request at least every POLL_MS while it waits.
    expect(Math.max(...h.state.sleeps)).toBeLessThanOrEqual(POLL_MS);
  });

  it("gives up after MAX_FAILURES errors in a row, and says so", async () => {
    const h = harness(Array.from({ length: MAX_FAILURES }, () => ({ code: 1, runsFor: 1_000 })));
    expect(await h.run()).toBe(1);
    expect(h.state.started).toHaveLength(MAX_FAILURES);
    expect(h.state.logs.at(-1)).toBe(
      `the daemon exited with code 1, ${MAX_FAILURES} times in a row; not starting it again until 'engram start' or the next sign-in`,
    );
    // About 25 minutes of waits in all, before it gives up.
    const total = waits(h.state, 1_000).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(20 * 60_000);
    expect(total).toBeLessThan(30 * 60_000);
  });

  it("names the command that starts it as the CLI that runs it is run: npx's, from npx's cache (engram#727)", async () => {
    const npx = (rest: string) => `npx @getengram/cli ${rest}`;
    const h = harness(
      Array.from({ length: MAX_FAILURES }, () => ({ code: 1, runsFor: 1_000 })),
      { command: npx },
    );
    expect(await h.run()).toBe(1);
    expect(h.state.logs.at(-1)).toBe(
      `the daemon exited with code 1, ${MAX_FAILURES} times in a row; not starting it again until 'npx @getengram/cli start' or the next sign-in`,
    );

    const failed = harness([{ code: START_FAILED_EXIT, runsFor: 2_000 }], {
      reportUntil: 1_000_000 + 8_000,
      command: npx,
    });
    expect(await failed.run()).toBe(START_FAILED_EXIT);
    expect(failed.state.logs).toEqual([
      "the daemon couldn't start (exit code 3); 'npx @getengram/cli start' reports it, and it isn't started again",
    ]);
  });

  it("counts an error after a long run as the first again", async () => {
    // A worker that ran 10 minutes and more was fine until then: one more
    // failure after it is no sign that starting it again doesn't help.
    const h = harness([
      { code: 1, runsFor: 1_000 },
      { code: 1, runsFor: 1_000 },
      { code: 1, runsFor: STABLE_MS },
      { code: 0, runsFor: 1_000 },
    ]);
    expect(await h.run()).toBe(0);
    expect(h.state.sleeps.reduce((a, b) => a + b, 0)).toBe(10_000 + 20_000 + 10_000);
  });

  it("starts a worker again that ended without an exit code, or couldn't be started", async () => {
    // Task Manager's End task (TerminateProcess) ends it with code 1; a
    // signal, with none. A spawn can fail outright too.
    const h = harness([{ code: null, runsFor: 5_000 }, { throws: "spawn EAGAIN", code: null }, { code: 0 }]);
    expect(await h.run()).toBe(0);
    expect(h.state.started).toHaveLength(3);
    expect(h.state.logs).toEqual([
      "the daemon exited without an exit code; starting it again in 10s",
      "couldn't start the daemon: spawn EAGAIN",
      "the daemon exited without an exit code; starting it again in 20s",
    ]);
  });

  it("doesn't start a worker again that `engram stop` asked to stop, however it exits", async () => {
    // `engram stop` ended one that didn't take the request in time: on
    // Windows that is TerminateProcess, exit code 1.
    const h = harness([{ code: 1, runsFor: 30_000, onExit: () => h.stop() }]);
    expect(await h.run()).toBe(0);
    expect(h.state.started).toHaveLength(1);
    expect(h.state.removed).toEqual(["stamp-1"]);
    expect(h.state.stamp).toBeNull();
    expect(h.state.logs).toEqual(["stopped by 'engram stop'; not starting it again"]);
  });

  it("takes a request to stop while it waits to start a worker again", async () => {
    // `engram stop` with the daemon down for now: it writes a request for
    // whatever would start next.
    const h = harness([{ code: 1, runsFor: 1_000 }]);
    h.state.at.push({ t: h.state.t + 1_000 + 4_500, run: () => h.stop() });
    expect(await h.run()).toBe(0);
    expect(h.state.started).toHaveLength(1);
    expect(h.state.removed).toEqual(["stamp-1"]);
    expect(h.state.logs.at(-1)).toBe("stopped by 'engram stop'; not starting it again");
    // Within a poll of the request, not after the whole wait.
    expect(h.state.t - (1_000_000 + 1_000 + 4_500)).toBeLessThanOrEqual(POLL_MS);
  });

  it("isn't stopped by a request from before it started the worker", async () => {
    // Left from an earlier `engram stop`: a worker that ran since then
    // would have removed it, but one ended outright couldn't.
    const h = harness([{ code: 1, runsFor: 1_000 }, { code: 0 }]);
    h.stop();
    expect(await h.run()).toBe(0);
    expect(h.state.started).toHaveLength(2);
    expect(h.state.removed).toEqual([]);
  });

  it("leaves the capture to another daemon that answers by the time it would start one", async () => {
    const h = harness([{ code: 1, runsFor: 1_000 }]);
    h.state.at.push({ t: h.state.t + 3_000, run: () => (h.state.running = true) });
    expect(await h.run()).toBe(0);
    expect(h.state.started).toHaveLength(1);
    expect(h.state.logs.at(-1)).toBe("another daemon is running; leaving the capture to it");
  });

  describe("while `engram start` waits on the first worker", () => {
    it("exits with START_FAILED_EXIT when that one couldn't start, for it to report, and starts none again", async () => {
      const h = harness([{ code: START_FAILED_EXIT, runsFor: 2_000 }], { reportUntil: 1_000_000 + 8_000 });
      expect(await h.run()).toBe(START_FAILED_EXIT);
      expect(h.state.started).toHaveLength(1);
      expect(h.state.logs).toEqual([
        "the daemon couldn't start (exit code 3); 'engram start' reports it, and it isn't started again",
      ]);
    });

    it("starts it again once `engram start` has stopped waiting", async () => {
      // Past reportUntil, `engram start` may have said it was starting, and
      // is gone: nobody would report it.
      const h = harness([{ code: START_FAILED_EXIT, runsFor: 9_000 }, { code: 0 }], {
        reportUntil: 1_000_000 + 8_000,
      });
      expect(await h.run()).toBe(0);
      expect(h.state.started).toHaveLength(2);
    });

    it("starts again one that failed after it was ready: `engram start` said it started", async () => {
      const h = harness([{ code: 1, runsFor: 2_000 }, { code: 0 }], { reportUntil: 1_000_000 + 8_000 });
      expect(await h.run()).toBe(0);
      expect(h.state.started).toHaveLength(2);
    });

    it("only for the first worker", async () => {
      const h = harness(
        [
          { code: 1, runsFor: 1 },
          { code: START_FAILED_EXIT, runsFor: 1 },
          { code: 0 },
        ],
        { reportUntil: Number.MAX_SAFE_INTEGER },
      );
      expect(await h.run()).toBe(0);
      expect(h.state.started).toHaveLength(3);
    });
  });

  it("at sign-in, starts again a worker that couldn't start: nothing waits on it to report", async () => {
    const h = harness([{ code: START_FAILED_EXIT, runsFor: 2_000 }, { code: 0 }]);
    expect(await h.run()).toBe(0);
    expect(h.state.started).toHaveLength(2);
    expect(h.state.logs[0]).toBe("the daemon exited with code 3; starting it again in 10s");
  });

  it("reads --report-until, and nothing else for it", () => {
    expect(reportUntilArg(["--report-until=1762700000000"])).toBe(1_762_700_000_000);
    expect(reportUntilArg(["--other", "--report-until=5"])).toBe(5);
    for (const args of [[], ["--report-until="], ["--report-until=-5"], ["--report-until=1e12"], ["--report-until=12x"]]) {
      expect(reportUntilArg(args), args.join(" ")).toBe(0);
    }
    expect(reportUntilArg([`--report-until=${"9".repeat(16)}`])).toBe(0);
  });

  it("takes for a failed start only a code no worker that was ready exits with", () => {
    // 0: it was stopped. 1: an error after it was ready, and Windows ends a
    // process outright (Task Manager, `engram stop`) with 1 too. Either one
    // taken for a failed start would leave a worker that `engram start`
    // already said had started down, and nobody reporting it.
    expect([0, 1]).not.toContain(START_FAILED_EXIT);
    expect(FIRST_DELAY_MS).toBe(10_000);
  });
});

/**
 * engram#727 — supervisor.ts, the process: what it logs names the command
 * that starts the daemon as the CLI that runs it is run. Its processes and
 * files are mocked; supervise() only records what it is given.
 */
describe("the supervisor process (engram#727)", () => {
  const realPlatform = process.platform;
  const FROM_NPX =
    "C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\f3920abdac2db749\\node_modules\\@getengram\\cli\\dist\\daemon\\login-start.js";
  const INSTALLED = "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@getengram\\cli\\dist\\daemon\\login-start.js";

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    vi.doUnmock("../daemon/supervise.js");
    vi.doUnmock("../daemon/launch.js");
    vi.doUnmock("../daemon/instance.js");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  /** Run supervisor.ts, its sign-in entry at `entry`: what it gave supervise(). */
  async function supervisorFrom(entry: string): Promise<SuperviseOptions> {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    vi.resetModules();
    const given: SuperviseOptions[] = [];
    vi.doMock("../daemon/supervise.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../daemon/supervise.js")>()),
      supervise: async (_deps: SuperviseDeps, options: SuperviseOptions) => {
        given.push(options);
        return 0;
      },
    }));
    vi.doMock("../daemon/launch.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../daemon/launch.js")>()),
      loginStartPath: () => entry,
      workerPath: () => entry.replace("login-start.js", "worker.js"),
      spawnWorker: () => {
        throw new Error("the test starts no worker");
      },
    }));
    vi.doMock("../daemon/instance.js", () => ({
      probeDaemon: async () => ({ state: "none" }),
      readStopFile: () => null,
      removeStopFileIf: () => false,
    }));
    const exits: (number | undefined)[] = [];
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => void exits.push(code)) as never);
    await import("../daemon/supervisor.js");
    expect(exits).toEqual([0]);
    expect(given).toHaveLength(1);
    return given[0];
  }

  it("names the command that starts the daemon as npx runs the CLI, from npx's cache", async () => {
    const { command } = await supervisorFrom(FROM_NPX);
    expect(command("start")).toBe("npx @getengram/cli start");
  });

  it("names it engram start when the CLI is installed", async () => {
    const { command } = await supervisorFrom(INSTALLED);
    expect(command("start")).toBe("engram start");
  });
});
