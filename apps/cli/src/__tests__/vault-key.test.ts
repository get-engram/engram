import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// engram#677: a ~/.engram/vault-key that was there but couldn't be read —
// mode 000, a folder in its place, a link to a drive that isn't mounted —
// counted as no key. `engram store` then sent the secrets it would have
// encrypted as they were, the daemon sent captures without the vault's
// values scrubbed, and `vault keygen --save` replaced a key it couldn't
// back up. Only a file that isn't there is no key now.

const { home } = vi.hoisted(() => ({ home: { dir: "" } }));

// vault-key.ts keeps the key in ~/.engram: a temp home.
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));
// The real readFile, so a test can make one read fail as a disk can.
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, readFile: vi.fn(fs.readFile) };
});

home.dir = mkdtempSync(join(tmpdir(), "engram-677-home-"));
const ENGRAM = join(home.dir, ".engram");
const KEY_FILE = join(ENGRAM, "vault-key");

// After the temp home is set: these take their paths from it when imported.
const { readFile } = await import("node:fs/promises");
const {
  asVaultKeyProblem,
  readVaultKey,
  readVaultKeyFile,
  VAULT_KEY_FILE,
  vaultKeyFileState,
  VaultKeyUnreadable,
  vaultKeyFix,
} = await import("../vault-key.js");
const { vaultKeygen, vaultStatus } = await import("../commands/vault.js");

process.on("exit", () => rmSync(home.dir, { recursive: true, force: true }));

const posix = process.platform !== "win32";
const root = process.geteuid?.() === 0;
/** Modes and links: off Windows. */
const posixIt = it.skipIf(!posix);
/** A file of mode 000: root reads it anyway. */
const unreadableIt = it.skipIf(!posix || root);

/** A test key: 32 bytes, as `vault keygen` makes. */
const KEY = Buffer.alloc(32, 7).toString("base64");
const ENV_KEY = Buffer.alloc(32, 9).toString("base64");
/** In an error's message, as some carry the path or what was read. */
const LEAK = "Q7X9-LEAK";

const errno = (code: string, message = `${code}: injected ${LEAK}`) => Object.assign(new Error(message), { code });

/** What `promise` rejects with. */
async function rejection(promise: Promise<unknown>): Promise<InstanceType<typeof VaultKeyUnreadable>> {
  try {
    await promise;
  } catch (err) {
    return err as InstanceType<typeof VaultKeyUnreadable>;
  }
  throw new Error("didn't reject");
}

const realPlatform = process.platform;
let out: string[];
let errs: string[];
let exits: Array<number | undefined>;

beforeEach(() => {
  rmSync(ENGRAM, { recursive: true, force: true });
  mkdirSync(ENGRAM, { mode: 0o700 });
  out = [];
  errs = [];
  exits = [];
  vi.stubEnv("NO_COLOR", "1");
  vi.stubEnv("ENGRAM_VAULT_KEY", undefined);
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void out.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errs.push(args.join(" ")));
  // Exiting stops the command, as it does.
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exits.push(code);
    throw new Error(`exit ${code}`);
  }) as never);
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  // A file left mode 000 by a test that failed: readable again, to clean up.
  if (existsSync(KEY_FILE) && !lstatSync(KEY_FILE).isSymbolicLink()) chmodSync(KEY_FILE, 0o700);
  vi.mocked(readFile).mockClear();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("reading the vault key: only a file that isn't there is no key (engram#677)", () => {
  it("no file: no key", async () => {
    expect(await readVaultKeyFile()).toBeUndefined();
    expect(await readVaultKey()).toBeUndefined();
    expect(await vaultKeyFileState()).toBe("none");
  });

  it("no ~/.engram at all: no key", async () => {
    rmSync(ENGRAM, { recursive: true, force: true });
    expect(await readVaultKeyFile()).toBeUndefined();
    expect(await vaultKeyFileState()).toBe("none");
  });

  it("a key: read, without the line's end", async () => {
    writeFileSync(KEY_FILE, `  ${KEY}\n`, { mode: 0o600 });
    expect(await readVaultKeyFile()).toBe(KEY);
    expect(await readVaultKey()).toBe(KEY);
    expect(await vaultKeyFileState()).toBe("key");
  });

  unreadableIt("mode 000: there is a key that can't be read, not no key", async () => {
    writeFileSync(KEY_FILE, `${KEY}\n`, { mode: 0o600 });
    chmodSync(KEY_FILE, 0o000);
    const err = await rejection(readVaultKeyFile());
    expect(err).toBeInstanceOf(VaultKeyUnreadable);
    expect(err.kind).toBe("permission");
    expect(err.message).toBe("~/.engram/vault-key can't be read: permission denied");
    expect(await rejection(readVaultKey())).toBeInstanceOf(VaultKeyUnreadable);
    const state = await vaultKeyFileState();
    expect(state).toBeInstanceOf(VaultKeyUnreadable);
    expect((state as InstanceType<typeof VaultKeyUnreadable>).kind).toBe("permission");
    expect(vaultKeyFix(err)).toBe("Make it readable with: chmod 600 ~/.engram/vault-key");
  });

  it("a folder in its place: can't be read", async () => {
    mkdirSync(KEY_FILE);
    const err = await rejection(readVaultKeyFile());
    expect(err).toBeInstanceOf(VaultKeyUnreadable);
    expect(err.kind).toBe("folder");
    expect(err.message).toBe("~/.engram/vault-key is a folder, not a file");
    expect(vaultKeyFix(err)).toBe("Move the folder aside, and put your vault key back in ~/.engram/vault-key.");
  });

  posixIt("a link to a file that isn't there, as on a drive not mounted: can't be read, not no key", async () => {
    symlinkSync(join(home.dir, "Volumes", "keys", "vault-key"), KEY_FILE);
    const err = await rejection(readVaultKeyFile());
    expect(err).toBeInstanceOf(VaultKeyUnreadable);
    expect(err.kind).toBe("link");
    expect(err.message).toBe("~/.engram/vault-key is a link to a file that isn't there");
    expect(vaultKeyFix(err)).toBe(
      "Connect the drive the link points to again, or put your vault key in its place.",
    );
  });

  posixIt("a link to a key: the key", async () => {
    const elsewhere = join(home.dir, "keys");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "vault-key"), `${KEY}\n`, { mode: 0o600 });
    symlinkSync(join(elsewhere, "vault-key"), KEY_FILE);
    expect(await readVaultKeyFile()).toBe(KEY);
  });

  it("an empty file, or one of blanks: a key that may have been lost, not no key", async () => {
    for (const text of ["", " \n\t\n"]) {
      writeFileSync(KEY_FILE, text, { mode: 0o600 });
      const err = await rejection(readVaultKeyFile());
      expect(err).toBeInstanceOf(VaultKeyUnreadable);
      expect(err.kind).toBe("empty");
      expect(err.message).toBe("~/.engram/vault-key is empty");
      expect(vaultKeyFix(err)).toBe(
        "Put your vault key back in it. If you don't use the vault, delete the empty file.",
      );
    }
  });

  it("a read that fails as a disk can: named by its code, never its message", async () => {
    writeFileSync(KEY_FILE, `${KEY}\n`, { mode: 0o600 });
    vi.mocked(readFile).mockRejectedValueOnce(errno("EIO"));
    const err = await rejection(readVaultKeyFile());
    expect(err.kind).toBe("other");
    expect(err.message).toBe("~/.engram/vault-key can't be read (EIO)");
    expect(vaultKeyFix(err)).toBe("Check the file, and the disk it is on.");

    vi.mocked(readFile).mockRejectedValueOnce(new Error(`no code ${LEAK}`));
    expect((await rejection(readVaultKeyFile())).message).toBe("~/.engram/vault-key can't be read");
  });

  it("ENOENT for a file that is there is a link to nothing, not no key", async () => {
    // A link swapped in between the read and the look at what is there.
    writeFileSync(KEY_FILE, `${KEY}\n`, { mode: 0o600 });
    vi.mocked(readFile).mockRejectedValueOnce(errno("ENOENT"));
    const err = await rejection(readVaultKeyFile());
    expect(err.kind).toBe("link");
  });

  it("ENGRAM_VAULT_KEY wins over the file, which isn't read; the file's state is still the file's", async () => {
    vi.stubEnv("ENGRAM_VAULT_KEY", ENV_KEY);
    mkdirSync(KEY_FILE);
    expect(await readVaultKey()).toBe(ENV_KEY);
    expect(vi.mocked(readFile)).not.toHaveBeenCalled();
    // The daemon reads the file: it doesn't have the shell's ENGRAM_VAULT_KEY.
    const state = await vaultKeyFileState();
    expect(state).toBeInstanceOf(VaultKeyUnreadable);
    expect((state as InstanceType<typeof VaultKeyUnreadable>).kind).toBe("folder");
  });

  it("an empty ENGRAM_VAULT_KEY is no key in it: the file's is used", async () => {
    vi.stubEnv("ENGRAM_VAULT_KEY", "");
    writeFileSync(KEY_FILE, `${KEY}\n`, { mode: 0o600 });
    expect(await readVaultKey()).toBe(KEY);
  });

  it("never says what the file holds, nor what the error said", async () => {
    writeFileSync(KEY_FILE, `${KEY}\n`, { mode: 0o600 });
    const said: string[] = [];
    for (const code of ["EACCES", "EISDIR", "ENOENT", "EIO", "ELOOP"]) {
      vi.mocked(readFile).mockRejectedValueOnce(errno(code, `${code}: open '${KEY_FILE}' ${KEY} ${LEAK}`));
      const err = await rejection(readVaultKeyFile());
      said.push(err.message, vaultKeyFix(err));
    }
    const text = said.join("\n");
    expect(text).not.toContain(LEAK);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(KEY.slice(0, 8));
    expect(text).not.toContain(home.dir);
  });
});

describe("asVaultKeyProblem", () => {
  it("a VaultKeyUnreadable as it is; anything else, a key that can't be read", () => {
    const problem = new VaultKeyUnreadable("is empty", "empty");
    expect(asVaultKeyProblem(problem)).toBe(problem);
    const other = asVaultKeyProblem(new Error(`boom ${LEAK}`));
    expect(other).toBeInstanceOf(VaultKeyUnreadable);
    expect(other.kind).toBe("other");
    expect(other.message).toBe("~/.engram/vault-key can't be read");
    expect(asVaultKeyProblem(undefined).message).toBe("~/.engram/vault-key can't be read");
  });
});

describe("vaultKeyFix: what fixes it", () => {
  const problem = (kind: ConstructorParameters<typeof VaultKeyUnreadable>[1]) =>
    new VaultKeyUnreadable("x", kind);

  it("a key the daemon held sends for, gone: put it back, or restart without one", () => {
    expect(vaultKeyFix(problem("gone"))).toBe(
      "Put your vault key back in it. If you don't use the vault, run 'engram stop', then " +
        "'engram start': the daemon starts without a key, and sends what it held.",
    );
  });

  it("permission denied on Windows: no chmod there", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    expect(vaultKeyFix(problem("permission"))).toBe("Give your account permission to read it.");
  });

  posixIt("permission denied on another user's file, as after `sudo engram …`: make it yours", () => {
    writeFileSync(KEY_FILE, `${KEY}\n`, { mode: 0o600 });
    const euid = process.geteuid!();
    vi.spyOn(process as Required<NodeJS.Process>, "geteuid").mockReturnValue(euid + 1);
    expect(vaultKeyFix(problem("permission"))).toBe(
      `It isn't yours: make it yours with: sudo chown -R "$(id -un)" ~/.engram`,
    );
  });

  posixIt("permission denied on the user's own file: chmod", () => {
    writeFileSync(KEY_FILE, `${KEY}\n`, { mode: 0o600 });
    expect(vaultKeyFix(problem("permission"))).toBe("Make it readable with: chmod 600 ~/.engram/vault-key");
  });
});

describe("vault keygen --save over a key that can't be read (engram#677)", () => {
  /** What is in ~/.engram, so a backup or a new key would show. */
  const files = () => readdirSync(ENGRAM).sort();
  const REFUSED = (problem: string, fix: string) => [
    `Error: ~/.engram/vault-key ${problem}, so it can't be backed up, and isn't replaced.`,
    `  ${fix}`,
    "  Then run this again. Or move it aside yourself:",
    "    mv ~/.engram/vault-key ~/.engram/vault-key.old",
  ];

  it("a folder in its place: refused, with --force too, and nothing in it touched", async () => {
    mkdirSync(KEY_FILE);
    writeFileSync(join(KEY_FILE, "keep"), "kept");
    for (const flags of [{ save: "" }, { save: "", force: "" }] as Array<Record<string, string>>) {
      errs = [];
      await expect(vaultKeygen([], flags)).rejects.toThrow("exit 1");
      expect(errs).toEqual(
        REFUSED(
          "is a folder, not a file",
          "Move the folder aside, and put your vault key back in ~/.engram/vault-key.",
        ),
      );
    }
    expect(exits).toEqual([1, 1]);
    expect(files()).toEqual(["vault-key"]);
    expect(readdirSync(KEY_FILE)).toEqual(["keep"]);
    expect(out.join("\n")).not.toContain("Vault key generated");
  });

  unreadableIt("mode 000: refused, with --force too; the key in it kept, and no new one made", async () => {
    writeFileSync(KEY_FILE, `${KEY}\n`, { mode: 0o600 });
    chmodSync(KEY_FILE, 0o000);
    await expect(vaultKeygen([], { save: "", force: "" })).rejects.toThrow("exit 1");
    expect(errs).toEqual(
      REFUSED("can't be read: permission denied", "Make it readable with: chmod 600 ~/.engram/vault-key"),
    );
    expect(files()).toEqual(["vault-key"]);
    chmodSync(KEY_FILE, 0o600);
    expect(readFileSync(KEY_FILE, "utf-8")).toBe(`${KEY}\n`);
  });

  posixIt("a link to nothing: refused, and the link left as it is", async () => {
    const target = join(home.dir, "Volumes", "keys", "vault-key");
    symlinkSync(target, KEY_FILE);
    await expect(vaultKeygen([], { save: "", force: "" })).rejects.toThrow("exit 1");
    expect(errs[0]).toBe(
      "Error: ~/.engram/vault-key is a link to a file that isn't there, so it can't be backed up, and isn't replaced.",
    );
    expect(lstatSync(KEY_FILE).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(false);
  });

  it("an empty file: replaced, since there is nothing in it to lose", async () => {
    writeFileSync(KEY_FILE, "", { mode: 0o600 });
    await vaultKeygen([], { save: "" });
    expect(exits).toEqual([]);
    expect(files()).toEqual(["vault-key"]); // no backup of nothing
    const saved = readFileSync(KEY_FILE, "utf-8").trim();
    expect(Buffer.from(saved, "base64")).toHaveLength(32);
  });

  it("a key: still refused without --force, and backed up with it", async () => {
    writeFileSync(KEY_FILE, `${KEY}\n`, { mode: 0o600 });
    await expect(vaultKeygen([], { save: "" })).rejects.toThrow("exit 1");
    expect(readFileSync(KEY_FILE, "utf-8")).toBe(`${KEY}\n`);

    exits = [];
    await vaultKeygen([], { save: "", force: "" });
    expect(exits).toEqual([]);
    const backups = files().filter((name) => name.startsWith("vault-key.bak-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(ENGRAM, backups[0]), "utf-8")).toBe(`${KEY}\n`);
    expect(readFileSync(KEY_FILE, "utf-8")).not.toBe(`${KEY}\n`);
  });
});

describe("vault status (engram#677)", () => {
  it("a key that can't be read: said, with the fix, not 'not configured'", async () => {
    mkdirSync(KEY_FILE);
    await vaultStatus();
    expect(out).toEqual([
      "Vault: the key can't be read: ~/.engram/vault-key is a folder, not a file",
      "  Move the folder aside, and put your vault key back in ~/.engram/vault-key.",
      "  Until then, commands that need the key won't run, and the daemon holds",
      "  messages on this machine rather than send them unscrubbed.",
    ]);
  });

  it("ENGRAM_VAULT_KEY, and a file the daemon reads that can't be read: both said", async () => {
    vi.stubEnv("ENGRAM_VAULT_KEY", ENV_KEY);
    mkdirSync(KEY_FILE);
    await vaultStatus();
    expect(out).toEqual([
      "Vault: configured (key in ENGRAM_VAULT_KEY)",
      "  ~/.engram/vault-key, which the daemon reads, is a folder, not a file. See 'engram status'.",
    ]);
  });

  it("ENGRAM_VAULT_KEY, and no file: the key in it", async () => {
    vi.stubEnv("ENGRAM_VAULT_KEY", ENV_KEY);
    await vaultStatus();
    expect(out).toEqual(["Vault: configured (key in ENGRAM_VAULT_KEY)"]);
  });

  it("no file: not configured, and how to make a key", async () => {
    await vaultStatus();
    expect(out).toEqual(["Vault: not configured", "Run 'engram vault keygen --save' to generate a key."]);
  });

  it("a key: configured", async () => {
    writeFileSync(KEY_FILE, `${KEY}\n`, { mode: 0o600 });
    await vaultStatus();
    expect(out).toEqual([`Vault: configured (key at ${VAULT_KEY_FILE})`, `Key prefix: ${KEY.slice(0, 8)}...`]);
  });
});
