import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * engram#682 — run as root for the user, as with sudo, the CLI runs only
 * `engram help` and `engram version`, and they print only themselves. This
 * runs the CLI's entry as `engram <command>` does, with every command
 * faked: what a fake records is what would have run. The home directory
 * is a temp dir, and nothing reaches the network.
 */

const { home, asRoot, ran, looked, fetched, fake } = vi.hoisted(() => {
  const ran: string[] = [];
  return {
    home: { dir: "" },
    asRoot: { value: false },
    ran,
    // What the lines before a command read: the config, status.json, and
    // who owns ~/.engram's files.
    looked: [] as string[],
    fetched: [] as string[],
    fake: (...names: string[]) => Object.fromEntries(names.map((name) => [name, async () => void ran.push(name)])),
  };
});

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));
vi.mock("../daemon/as-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/as-root.js")>()),
  rootForAnotherUser: () => asRoot.value,
}));
vi.mock("../commands/auth.js", () => fake("authLogin", "authLogout", "authStatus"));
vi.mock("../commands/login.js", () => fake("signup", "login", "link", "whoami"));
vi.mock("../commands/conversations.js", () =>
  fake("listConversations", "createConversation", "getConversation", "deleteConversation"),
);
vi.mock("../commands/store.js", () => fake("store"));
vi.mock("../commands/search.js", () => fake("search"));
vi.mock("../commands/log.js", () => fake("log"));
vi.mock("../commands/import.js", () => fake("importHistory"));
vi.mock("../commands/upgrade.js", () => fake("upgrade"));
vi.mock("../commands/usage.js", () => fake("usage"));
vi.mock("../commands/status.js", () => fake("status"));
vi.mock("../commands/vault.js", () =>
  fake("vaultKeygen", "vaultSaveKey", "vaultStatus", "vaultSet", "vaultGet", "vaultList", "vaultDelete"),
);
vi.mock("../commands/exclude.js", () => fake("excludeAdd", "excludeRemove", "excludeList"));
vi.mock("../daemon/index.js", () => fake("daemonStart", "daemonStop", "daemonStatus", "daemonInstall", "daemonUninstall"));
vi.mock("../daemon/commands.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/commands.js")>()),
  autoEnableCapture: async () => void ran.push("autoEnableCapture"),
}));
vi.mock("../config-guard.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../config-guard.js")>();
  return {
    ...real,
    configProblem: (...args: Parameters<typeof real.configProblem>) => {
      looked.push("config");
      return real.configProblem(...args);
    },
  };
});
vi.mock("../daemon/status.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../daemon/status.js")>();
  return {
    ...real,
    readStatus: (...args: Parameters<typeof real.readStatus>) => {
      looked.push("status.json");
      return real.readStatus(...args);
    },
  };
});
vi.mock("../daemon/ownership.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../daemon/ownership.js")>();
  return {
    ...real,
    foreignFiles: (...args: Parameters<typeof real.foreignFiles>) => {
      looked.push("owners");
      return real.foreignFiles(...args);
    },
  };
});

home.dir = mkdtempSync(join(tmpdir(), "engram-682-"));
afterAll(() => rmSync(home.dir, { recursive: true, force: true }));

const AS_YOU = "Engram runs as you, and this is running as root.";
const run = (cmd: string): string => `  Run '${cmd}' as yourself, without sudo.`;

describe("run as root for the user, as with sudo (engram#682)", () => {
  const argv = process.argv;
  let out: string[];
  let errs: string[];

  beforeEach(() => {
    out = [];
    errs = [];
    ran.length = 0;
    looked.length = 0;
    fetched.length = 0;
    asRoot.value = true;
    vi.stubEnv("NO_COLOR", "1");
    vi.stubGlobal("fetch", async (url: unknown) => {
      fetched.push(String(url));
      throw new Error("no network in this test");
    });
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void out.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errs.push(args.join(" ")));
  });

  afterEach(() => {
    process.argv = argv;
    process.exitCode = undefined;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** `engram <words>`: the entry runs its command as it is imported. */
  async function engram(...words: string[]): Promise<void> {
    const before = ran.length + out.length + errs.length;
    process.argv = [argv[0], "engram", ...words];
    vi.resetModules();
    await import("../index.js");
    await vi.waitFor(() => expect(ran.length + out.length + errs.length).toBeGreaterThan(before));
    // What the entry does after the command, which a fake doesn't wait for.
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  /** Refused: the two lines, exit 1, and nothing run, read or written. */
  async function refused(words: string[], lines: string[]): Promise<void> {
    errs.length = 0;
    out.length = 0;
    process.exitCode = undefined;
    await engram(...words);
    expect({ words, errs, out, exitCode: process.exitCode }).toEqual({ words, errs: lines, out: [], exitCode: 1 });
    expect({ words, ran, looked, fetched }).toEqual({ words, ran: [], looked: [], fetched: [] });
    expect(existsSync(join(home.dir, ".engram"))).toBe(false);
  }

  it("refuses every command that reads or writes, and says to run it as yourself", async () => {
    for (const [words, cmd] of [
      [["login"], "login"],
      [["login", "--key", "eng_made_up"], "login"],
      [["signup"], "signup"],
      [["link"], "link"],
      [["whoami"], "whoami"],
      [["auth", "login"], "auth login"],
      [["auth", "logout"], "auth logout"],
      [["auth", "status"], "auth status"],
      [["exclude", "add", "/work/private"], "exclude add"],
      [["exclude", "remove", "/work/private"], "exclude remove"],
      [["exclude", "list"], "exclude list"],
      [["vault", "keygen", "--save"], "vault keygen"],
      [["vault", "save-key"], "vault save-key"],
      [["vault", "status"], "vault status"],
      [["vault", "set", "DOOR_CODE", "--value", "made-up"], "vault set"],
      [["vault", "get", "DOOR_CODE"], "vault get"],
      [["status"], "status"],
      [["daemon", "status"], "daemon status"],
      [["upgrade"], "upgrade"],
      [["usage"], "usage"],
      [["search", "what we said"], "search"],
      [["store", "--conversation", "conv_x", "text"], "store"],
      [["log"], "log"],
      [["import"], "import"],
      [["convs"], "convs"],
      [["conversations", "list"], "conversations list"],
      [["uninstall"], "uninstall"],
      [["daemon", "uninstall"], "daemon uninstall"],
      [["frobnicate"], "frobnicate"],
    ] as [string[], string][]) {
      await refused(words, [AS_YOU, run(`engram ${cmd}`)]);
    }
  });

  it("says why start and install are per user", async () => {
    for (const [words, cmd] of [
      [["start"], "start"],
      [["start", "--install"], "start"],
      [["daemon", "start"], "daemon start"],
    ] as [string[], string][]) {
      await refused(words, ["Engram's daemon runs as you, and this is running as root.", run(`engram ${cmd}`)]);
    }
    for (const [words, cmd] of [
      [["install"], "install"],
      [["daemon", "install"], "daemon install"],
    ] as [string[], string][]) {
      await refused(words, ["Start at login is per user, and this is running as root.", run(`engram ${cmd}`)]);
    }
  });

  it("says stop, run as yourself, says what stops a daemon started with sudo", async () => {
    for (const [words, cmd] of [
      [["stop"], "stop"],
      [["daemon", "stop"], "daemon stop"],
    ] as [string[], string][]) {
      await refused(words, [AS_YOU, `${run(`engram ${cmd}`)} For a daemon started with sudo, it says what stops it.`]);
    }
  });

  it("says only 'engram' for flags alone, and never a command's arguments", async () => {
    await refused(["--install"], [AS_YOU, run("engram")]);
    errs.length = 0;
    await engram("vault", "set", "DOOR_CODE", "--value", "made-up-secret");
    expect(errs.join("\n")).not.toMatch(/DOOR_CODE|made-up-secret/);
  });

  it("runs help and version, which print only themselves", async () => {
    for (const words of [["help"], ["version"], ["--help"], ["-h"], ["--version"], ["-v"], []]) {
      out.length = 0;
      errs.length = 0;
      process.exitCode = undefined;
      await engram(...words);
      expect({ words, errs, exitCode: process.exitCode }).toEqual({ words, errs: [], exitCode: undefined });
      expect(out.length).toBeGreaterThan(0);
      if (words.some((w) => /^(version|--version|-v)$/.test(w))) expect(out).toEqual([expect.stringMatching(/^engram \S+$/)]);
      // The whole help, not a line of it: the usage, and the commands.
      else expect(out.join("\n")).toMatch(/USAGE\n {2}engram <command> \[options\][\s\S]*COMMANDS[\s\S]*signup/);
    }
    expect({ ran, looked, fetched }).toEqual({ ran: [], looked: [], fetched: [] });
    expect(existsSync(join(home.dir, ".engram"))).toBe(false);
  });

  it("not as root, runs the command, after the lines before it", async () => {
    asRoot.value = false;
    await engram("stop");
    expect(ran).toEqual(["daemonStop"]);
    expect(errs).toEqual([]);
    expect(process.exitCode).toBeUndefined();
    // stop says config problems itself; status.json and the owners are read.
    expect(looked).toEqual(["status.json", "owners"]);
  });
});
