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
import { createHash } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
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
// A daemon from before engram#612 has no socket: its PID file names it,
// and only `ps` tells it from another process. A test says there is one.
const { pidFileDaemon } = vi.hoisted(() => ({ pidFileDaemon: { pid: null as number | null } }));
vi.mock("../daemon/instance.js", async (importOriginal) => {
  const instance = await importOriginal<typeof import("../daemon/instance.js")>();
  return {
    ...instance,
    confirmedDaemonInPidFile: () => pidFileDaemon.pid ?? instance.confirmedDaemonInPidFile(),
  };
});

home.dir = mkdtempSync(join(tmpdir(), "engram-677-home-"));
const ENGRAM = join(home.dir, ".engram");
const KEY_FILE = join(ENGRAM, "vault-key");

// After the temp home is set: these take their paths from it when imported.
const { readFile } = await import("node:fs/promises");
const {
  asVaultKeyProblem,
  envVaultKeySaved,
  envVaultKeyState,
  isVaultKey,
  readVaultKey,
  readVaultKeyFile,
  sameVaultKey,
  VAULT_KEY_FILE,
  vaultKeyFileState,
  vaultKeyFingerprint,
  VaultKeyUnreadable,
  vaultKeyFix,
  vaultKeySpellings,
  whyNotVaultKey,
} = await import("../vault-key.js");
const { vaultKeygen, vaultSaveKey, vaultStatus } = await import("../commands/vault.js");
const { daemonEndpoint } = await import("../daemon/instance.js");

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
/** A key no 8 characters of which repeat, so any of them shown would be seen. */
const VARIED = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 73 + 41) & 0xff)).toString("base64");
/** Each 8 characters of `key`: output showing any shows part of it (engram#699). */
const eightsOf = (key: string) => Array.from({ length: key.length - 7 }, (_, i) => key.slice(i, i + 8));
/** What of `key` `text` shows, 8 characters at a time: none, to pass. */
const shown = (text: string, key: string) => eightsOf(key).filter((eight) => text.includes(eight));
/** The fingerprint, worked out apart: the first 8 hex of SHA-256 over the key's bytes. */
const sha256Of = (key: string) => createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 8);

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
  // A ~/.engram left locked by a test that failed (engram#723): open again first.
  if (existsSync(ENGRAM)) chmodSync(ENGRAM, 0o700);
  // A file left mode 000 by a test that failed: readable again, to clean up.
  if (existsSync(KEY_FILE) && !lstatSync(KEY_FILE).isSymbolicLink()) chmodSync(KEY_FILE, 0o700);
  vi.mocked(readFile).mockClear();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  pidFileDaemon.pid = null;
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

  // engram#723: a ~/.engram the user can't search hides the file, whose
  // own bits are fine: a chmod of it can't reach it, and the folder is
  // what's wrong.
  unreadableIt.each([
    ["600", 0o600, "chmod u+x ~/.engram"],
    ["400", 0o400, "chmod u+wx ~/.engram"],
    ["000", 0o000, "chmod u+rwx ~/.engram"],
  ] as const)("in a ~/.engram of mode %s: the folder, and its chmod", async (_label, mode, command) => {
    writeFileSync(KEY_FILE, `${KEY}\n`, { mode: 0o600 });
    chmodSync(ENGRAM, mode);
    try {
      const err = await rejection(readVaultKeyFile());
      expect(err.kind).toBe("permission");
      expect(vaultKeyFix(err)).toBe(
        `~/.engram's permissions keep you from opening the files in it. To fix it, run: ${command}`,
      );
    } finally {
      chmodSync(ENGRAM, 0o700);
    }
    // The key is there as it was.
    expect(readFileSync(KEY_FILE, "utf8")).toBe(`${KEY}\n`);
  });

  unreadableIt("in a ~/.engram that only can't be written: the file's own chmod, as before", async () => {
    writeFileSync(KEY_FILE, `${KEY}\n`, { mode: 0o600 });
    chmodSync(KEY_FILE, 0o000);
    chmodSync(ENGRAM, 0o500);
    try {
      const err = await rejection(readVaultKeyFile());
      expect(err.kind).toBe("permission");
      expect(vaultKeyFix(err)).toBe("Make it readable with: chmod 600 ~/.engram/vault-key");
    } finally {
      chmodSync(ENGRAM, 0o700);
    }
  });
});

/** What is in ~/.engram, so a backup or a new key would show. */
const files = () => readdirSync(ENGRAM).sort();
/** A key in the file that can't be read isn't replaced: it can't be backed up. */
const REFUSED = (problem: string, fix: string) => [
  `Error: ~/.engram/vault-key ${problem}, so it can't be backed up, and isn't replaced.`,
  `  ${fix}`,
  "  Then run this again. Or move it aside yourself:",
  "    mv ~/.engram/vault-key ~/.engram/vault-key.old",
];

describe("vault keygen --save over a key that can't be read (engram#677)", () => {
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
      `Key fingerprint: ${sha256Of(ENV_KEY)}`,
      "  ~/.engram/vault-key, which the daemon reads, is a folder, not a file. See 'engram status'.",
    ]);
  });

  it("ENGRAM_VAULT_KEY, and no file: the key in it, and that a daemon started at login may not have it (engram#690)", async () => {
    vi.stubEnv("ENGRAM_VAULT_KEY", ENV_KEY);
    await vaultStatus();
    expect(out).toEqual([
      "Vault: configured (key in ENGRAM_VAULT_KEY)",
      `Key fingerprint: ${sha256Of(ENV_KEY)}`,
      "  ~/.engram/vault-key isn't there: a daemon started at login may not have this key.",
      "  To save it there, readable only by you: engram vault save-key",
    ]);
  });

  it("ENGRAM_VAULT_KEY, saved in the file: nothing more (engram#690)", async () => {
    vi.stubEnv("ENGRAM_VAULT_KEY", ENV_KEY);
    writeFileSync(KEY_FILE, `${ENV_KEY}\n`, { mode: 0o600 });
    await vaultStatus();
    expect(out).toEqual(["Vault: configured (key in ENGRAM_VAULT_KEY)", `Key fingerprint: ${sha256Of(ENV_KEY)}`]);
  });

  it("ENGRAM_VAULT_KEY, and another key in the file: which a daemon started at login may use (engram#690)", async () => {
    vi.stubEnv("ENGRAM_VAULT_KEY", ENV_KEY);
    writeFileSync(KEY_FILE, `${KEY}\n`, { mode: 0o600 });
    await vaultStatus();
    expect(out).toEqual([
      "Vault: configured (key in ENGRAM_VAULT_KEY)",
      `Key fingerprint: ${sha256Of(ENV_KEY)}`,
      "  ~/.engram/vault-key holds a different key: a daemon started at login may use that one.",
      "  If this one is right: engram vault save-key --force (the file's key is backed up first)",
    ]);
    expect(out.join("\n")).not.toContain(KEY.slice(0, 8));
    expect(out.join("\n")).not.toContain(ENV_KEY.slice(0, 8));
  });

  it("ENGRAM_VAULT_KEY that isn't a key: nothing said about saving it (engram#690)", async () => {
    vi.stubEnv("ENGRAM_VAULT_KEY", Buffer.alloc(16, 9).toString("base64"));
    await vaultStatus();
    expect(out).toEqual(["Vault: invalid key in ENGRAM_VAULT_KEY (expected 32 bytes, got 16)"]);
  });

  it("no file: not configured, and how to make a key", async () => {
    await vaultStatus();
    expect(out).toEqual(["Vault: not configured", "Run 'engram vault keygen --save' to generate a key."]);
  });

  it("a key: configured, and its fingerprint (engram#699)", async () => {
    writeFileSync(KEY_FILE, `${KEY}\n`, { mode: 0o600 });
    await vaultStatus();
    expect(out).toEqual([`Vault: configured (key at ${VAULT_KEY_FILE})`, `Key fingerprint: ${sha256Of(KEY)}`]);
  });
});

describe("the vault key's fingerprint, which shows none of the key (engram#699)", () => {
  it("the first 8 hex of SHA-256 over the key's bytes: one however the key is written, another for another key", () => {
    expect(vaultKeyFingerprint(VARIED)).toMatch(/^[0-9a-f]{8}$/);
    expect(vaultKeyFingerprint(VARIED)).toBe(sha256Of(VARIED));
    const unpadded = VARIED.replace(/=+$/, "");
    expect(unpadded).not.toBe(VARIED);
    for (const spelling of [unpadded, `  ${VARIED}\n`, `${unpadded}\r\n`]) {
      expect(vaultKeyFingerprint(spelling), JSON.stringify(spelling)).toBe(sha256Of(VARIED));
    }
    expect(vaultKeyFingerprint(KEY)).toBe(sha256Of(KEY));
    expect(sha256Of(KEY)).not.toBe(sha256Of(ENV_KEY));
    expect(vaultKeyFingerprint(ENV_KEY)).toBe(sha256Of(ENV_KEY));
    // Not a vault key: none.
    expect(vaultKeyFingerprint(Buffer.alloc(16, 7).toString("base64"))).toBeNull();
    expect(vaultKeyFingerprint(Buffer.alloc(32, 0xff).toString("base64url"))).toBeNull();
    expect(vaultKeyFingerprint(LEAK)).toBeNull();
    expect(vaultKeyFingerprint("")).toBeNull();
  });

  it("why a key isn't one, as status says it: what the SDK can't read, or how many bytes it holds", () => {
    expect(whyNotVaultKey(VARIED)).toBeNull();
    expect(whyNotVaultKey(` ${VARIED.replace(/=+$/, "")}\n`)).toBeNull();
    expect(whyNotVaultKey(Buffer.alloc(16, 7).toString("base64"))).toBe("expected 32 bytes, got 16");
    expect(whyNotVaultKey(Buffer.alloc(33, 7).toString("base64"))).toBe("expected 32 bytes, got 33");
    expect(whyNotVaultKey(Buffer.alloc(32, 0xff).toString("base64url"))).toBe("not base64");
    expect(whyNotVaultKey(LEAK)).toBe("not base64");
  });

  it("status: the fingerprint, and no 8 characters of the key, from the file or ENGRAM_VAULT_KEY", async () => {
    writeFileSync(KEY_FILE, `${VARIED}\n`, { mode: 0o600 });
    await vaultStatus();
    expect(out).toEqual([`Vault: configured (key at ${VAULT_KEY_FILE})`, `Key fingerprint: ${sha256Of(VARIED)}`]);
    expect(shown(out.join("\n"), VARIED)).toEqual([]);

    // The same key written another way: the same fingerprint.
    out = [];
    vi.stubEnv("ENGRAM_VAULT_KEY", `${VARIED.replace(/=+$/, "")}\n`);
    await vaultStatus();
    expect(out).toEqual(["Vault: configured (key in ENGRAM_VAULT_KEY)", `Key fingerprint: ${sha256Of(VARIED)}`]);
    expect(shown(out.join("\n"), VARIED)).toEqual([]);
  });

  it("status: a key the SDK can't read isn't configured, and has no fingerprint", async () => {
    const urlSafe = Buffer.alloc(32, 0xff).toString("base64url");
    writeFileSync(KEY_FILE, `${urlSafe}\n`, { mode: 0o600 });
    await vaultStatus();
    expect(out).toEqual(["Vault: invalid key (not base64)"]);
    out = [];
    vi.stubEnv("ENGRAM_VAULT_KEY", urlSafe);
    await vaultStatus();
    expect(out).toEqual(["Vault: invalid key in ENGRAM_VAULT_KEY (not base64)"]);
    out = [];
    writeFileSync(KEY_FILE, `${Buffer.alloc(16, 7).toString("base64")}\n`, { mode: 0o600 });
    vi.stubEnv("ENGRAM_VAULT_KEY", undefined);
    await vaultStatus();
    expect(out).toEqual(["Vault: invalid key (expected 32 bytes, got 16)"]);
  });

  it("keygen --save: the fingerprint status says, and no 8 characters of the key", async () => {
    rmSync(KEY_FILE, { force: true });
    await vaultKeygen([], { save: "" });
    const saved = readFileSync(KEY_FILE, "utf-8").trim();
    expect(out.slice(0, 3)).toEqual([
      `Vault key generated and saved to: ${VAULT_KEY_FILE}`,
      "Permissions set to owner-only (600).",
      `Key fingerprint: ${sha256Of(saved)}`,
    ]);
    expect(out).toContain(`  export ENGRAM_VAULT_KEY="$(cat ~/.engram/vault-key)"`);
    expect(shown([...out, ...errs].join("\n"), saved)).toEqual([]);

    const made = out[2];
    out = [];
    await vaultStatus();
    expect(out).toEqual([`Vault: configured (key at ${VAULT_KEY_FILE})`, made]);
  });

  it("keygen: the key, as asked, then its fingerprint; nothing more of it", async () => {
    await vaultKeygen([], {});
    const [key, fingerprint, ...rest] = out;
    expect(Buffer.from(key, "base64")).toHaveLength(32);
    expect(fingerprint).toBe(`Key fingerprint: ${sha256Of(key)}`);
    expect(shown(rest.join("\n"), key)).toEqual([]);
    expect(existsSync(KEY_FILE)).toBe(false);
  });
});

describe("a vault key as the SDK reads one (engram#690)", () => {
  it("32 bytes, base64: its padding, a line's end and blanks aside", () => {
    expect(isVaultKey(KEY)).toBe(true);
    expect(isVaultKey(KEY.replace(/=+$/, ""))).toBe(true);
    expect(isVaultKey(`  ${KEY}\n`)).toBe(true);
    expect(isVaultKey(Buffer.alloc(16, 7).toString("base64"))).toBe(false);
    expect(isVaultKey(Buffer.alloc(33, 7).toString("base64"))).toBe(false);
    // The SDK reads a key with atob, which doesn't take base64url.
    expect(isVaultKey(Buffer.alloc(32, 0xff).toString("base64url"))).toBe(false);
    expect(isVaultKey(LEAK)).toBe(false);
    expect(isVaultKey("")).toBe(false);
  });

  it("the same key, however written; text that isn't a key, by its text", () => {
    expect(sameVaultKey(KEY, `${KEY.replace(/=+$/, "")}\n`)).toBe(true);
    expect(sameVaultKey(KEY, ENV_KEY)).toBe(false);
    expect(sameVaultKey(LEAK, ` ${LEAK}\n`)).toBe(true);
    expect(sameVaultKey(LEAK, KEY)).toBe(false);
  });

  it("each way a key may be written, as the daemon scrubs it: trimmed, padded and not (engram#693)", () => {
    const unpadded = KEY.replace(/=+$/, "");
    expect(vaultKeySpellings(`  ${KEY}\n`)).toEqual([KEY, unpadded]);
    expect(vaultKeySpellings(`${unpadded}\n`)).toEqual([unpadded, KEY]);
    // Not a vault key: as it is written, trimmed.
    expect(vaultKeySpellings(` ${LEAK}\n`)).toEqual([LEAK]);
    const short = Buffer.alloc(16, 7).toString("base64");
    expect(vaultKeySpellings(short)).toEqual([short]);
  });
});

describe("ENGRAM_VAULT_KEY against ~/.engram/vault-key, which the daemon at login reads (engram#690)", () => {
  type Unreadable = InstanceType<typeof VaultKeyUnreadable>;

  it("ENGRAM_VAULT_KEY unset, or empty: unset, and nothing saved", async () => {
    writeFileSync(KEY_FILE, `${KEY}\n`, { mode: 0o600 });
    expect(await envVaultKeyState()).toBe("unset");
    expect(envVaultKeySaved()).toBe(false);
    vi.stubEnv("ENGRAM_VAULT_KEY", "");
    expect(await envVaultKeyState()).toBe("unset");
    expect(envVaultKeySaved()).toBe(false);
  });

  it("ENGRAM_VAULT_KEY that isn't a key: invalid, whatever the file holds", async () => {
    vi.stubEnv("ENGRAM_VAULT_KEY", LEAK);
    expect(await envVaultKeyState()).toBe("invalid");
    mkdirSync(KEY_FILE);
    expect(await envVaultKeyState()).toBe("invalid");
  });

  it("no file: none", async () => {
    vi.stubEnv("ENGRAM_VAULT_KEY", ENV_KEY);
    expect(await envVaultKeyState()).toBe("none");
    expect(envVaultKeySaved()).toBe(false);
  });

  it("the file holds it: the same, and saved, blanks and a line's end in either aside", async () => {
    vi.stubEnv("ENGRAM_VAULT_KEY", ENV_KEY);
    writeFileSync(KEY_FILE, `${ENV_KEY}\n`, { mode: 0o600 });
    expect(await envVaultKeyState()).toBe("same");
    expect(envVaultKeySaved()).toBe(true);

    vi.stubEnv("ENGRAM_VAULT_KEY", `${ENV_KEY}\n`);
    writeFileSync(KEY_FILE, `  ${ENV_KEY}  \n\n`, { mode: 0o600 });
    expect(await envVaultKeyState()).toBe("same");
    expect(envVaultKeySaved()).toBe(true);
  });

  it("the same key, written another way: the same key, but not saved as written here", async () => {
    // The daemon scrubs the key's own text too: started from the file, it
    // would scrub the file's.
    vi.stubEnv("ENGRAM_VAULT_KEY", ENV_KEY);
    writeFileSync(KEY_FILE, `${ENV_KEY.replace(/=+$/, "")}\n`, { mode: 0o600 });
    expect(await envVaultKeyState()).toBe("same");
    expect(envVaultKeySaved()).toBe(false);
  });

  it("another key: different, and not saved", async () => {
    vi.stubEnv("ENGRAM_VAULT_KEY", ENV_KEY);
    writeFileSync(KEY_FILE, `${KEY}\n`, { mode: 0o600 });
    expect(await envVaultKeyState()).toBe("different");
    expect(envVaultKeySaved()).toBe(false);
  });

  it("a file that can't be read, or is empty: why, and not saved", async () => {
    vi.stubEnv("ENGRAM_VAULT_KEY", ENV_KEY);
    mkdirSync(KEY_FILE);
    const folder = await envVaultKeyState();
    expect(folder).toBeInstanceOf(VaultKeyUnreadable);
    expect((folder as Unreadable).kind).toBe("folder");
    expect(envVaultKeySaved()).toBe(false);

    rmSync(KEY_FILE, { recursive: true });
    writeFileSync(KEY_FILE, " \n", { mode: 0o600 });
    expect(((await envVaultKeyState()) as Unreadable).kind).toBe("empty");
    expect(envVaultKeySaved()).toBe(false);
  });

  unreadableIt("mode 000: why, and not saved", async () => {
    vi.stubEnv("ENGRAM_VAULT_KEY", ENV_KEY);
    writeFileSync(KEY_FILE, `${ENV_KEY}\n`, { mode: 0o600 });
    chmodSync(KEY_FILE, 0o000);
    expect(((await envVaultKeyState()) as Unreadable).kind).toBe("permission");
    expect(envVaultKeySaved()).toBe(false);
  });
});

/** `server` listening where the daemon does. Returns how to stop it, and close what it holds open. */
async function onDaemonEndpoint(server: Server): Promise<() => Promise<void>> {
  const endpoint = daemonEndpoint();
  if ("unavailable" in endpoint) throw new Error(endpoint.unavailable);
  const open = new Set<Socket>();
  server.on("connection", (socket) => {
    socket.on("error", () => {});
    open.add(socket);
    socket.on("close", () => open.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint.path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return () =>
    new Promise<void>((resolve) => {
      for (const socket of open) socket.destroy();
      server.close(() => resolve());
    });
}

/**
 * A daemon answering on its socket, as `engram status` finds one. `reread`:
 * one that reads its vault key again while it runs (engram#693); without it,
 * one from before, which read it when it started. Returns how to stop it.
 */
function daemonAnswering({ stopping = false, reread = false } = {}): Promise<() => Promise<void>> {
  const answer = { engram: "daemon", protocol: 1, pid: 4242, ready: true, stopping, stop_file: true };
  const line = `${JSON.stringify(reread ? { ...answer, vault_key_reread: true } : answer)}\n`;
  return onDaemonEndpoint(createServer((socket) => socket.end(line)));
}

/**
 * A daemon too busy to answer, as in its first start after an update: it
 * takes the connection, and says nothing. Returns how to stop it.
 */
function daemonBusy(): Promise<() => Promise<void>> {
  return onDaemonEndpoint(createServer(() => {}));
}

describe("engram vault save-key (engram#690)", () => {
  const SAVED = [
    `Vault key saved to: ${VAULT_KEY_FILE}`,
    "Permissions set to owner-only (600). The daemon started at login reads it there.",
  ];
  const RESTART = [
    "The daemon running now read its key when it started. If that was without this one,",
    "as at login, run 'engram stop', then 'engram start'.",
  ];

  /** Nothing of either key is ever printed. */
  function neverPrinted(): void {
    const said = [...out, ...errs].join("\n");
    for (const key of [KEY, ENV_KEY]) expect(said).not.toContain(key.slice(0, 8));
    expect(said).not.toContain(LEAK);
  }

  it("ENGRAM_VAULT_KEY unset, or empty: refused, and nothing written", async () => {
    for (const value of [undefined, ""]) {
      vi.stubEnv("ENGRAM_VAULT_KEY", value);
      errs = [];
      await expect(vaultSaveKey({})).rejects.toThrow("exit 1");
      expect(errs).toEqual([
        "Error: ENGRAM_VAULT_KEY isn't set, so there is no key to save.",
        "  To make a new vault key and save it instead: engram vault keygen --save",
      ]);
    }
    expect(exits).toEqual([1, 1]);
    expect(files()).toEqual([]);
  });

  it("ENGRAM_VAULT_KEY that isn't a key: refused, nothing written, and what it holds never said", async () => {
    for (const value of [LEAK, Buffer.alloc(16, 9).toString("base64")]) {
      vi.stubEnv("ENGRAM_VAULT_KEY", value);
      errs = [];
      await expect(vaultSaveKey({ force: "" })).rejects.toThrow("exit 1");
      expect(errs).toEqual([
        "Error: ENGRAM_VAULT_KEY doesn't hold a vault key, so it isn't saved.",
        "  A vault key is 32 bytes, base64-encoded, as 'engram vault keygen' makes one.",
      ]);
    }
    expect(files()).toEqual([]);
    neverPrinted();
  });

  it("no file: saved as ENGRAM_VAULT_KEY has it, less blanks, readable only by the user", async () => {
    vi.stubEnv("ENGRAM_VAULT_KEY", `  ${ENV_KEY}\n`);
    await vaultSaveKey({});
    expect(exits).toEqual([]);
    expect(out).toEqual(SAVED);
    expect(readFileSync(KEY_FILE, "utf-8")).toBe(`${ENV_KEY}\n`);
    expect(files()).toEqual(["vault-key"]);
    if (posix) expect(lstatSync(KEY_FILE).mode & 0o777).toBe(0o600);
    expect(envVaultKeySaved()).toBe(true);
    neverPrinted();
  });

  it("no ~/.engram: made, the user's alone, and the key saved in it", async () => {
    rmSync(ENGRAM, { recursive: true, force: true });
    vi.stubEnv("ENGRAM_VAULT_KEY", ENV_KEY);
    await vaultSaveKey({});
    expect(out).toEqual(SAVED);
    expect(readFileSync(KEY_FILE, "utf-8")).toBe(`${ENV_KEY}\n`);
    if (posix) expect(lstatSync(ENGRAM).mode & 0o777).toBe(0o700);
  });

  it("the key already saved: said, and the file left as it is", async () => {
    vi.stubEnv("ENGRAM_VAULT_KEY", ENV_KEY);
    writeFileSync(KEY_FILE, ` ${ENV_KEY}\n\n`, { mode: 0o600 });
    await vaultSaveKey({});
    expect(exits).toEqual([]);
    expect(out).toEqual([`Already saved: ${VAULT_KEY_FILE} holds the key in ENGRAM_VAULT_KEY.`]);
    expect(readFileSync(KEY_FILE, "utf-8")).toBe(` ${ENV_KEY}\n\n`);
    expect(files()).toEqual(["vault-key"]);
    neverPrinted();
  });

  it("the same key, written another way: written as ENGRAM_VAULT_KEY has it, without --force or a backup", async () => {
    vi.stubEnv("ENGRAM_VAULT_KEY", ENV_KEY);
    writeFileSync(KEY_FILE, `${ENV_KEY.replace(/=+$/, "")}\n`, { mode: 0o600 });
    await vaultSaveKey({});
    expect(exits).toEqual([]);
    expect(out).toEqual(SAVED);
    expect(readFileSync(KEY_FILE, "utf-8")).toBe(`${ENV_KEY}\n`);
    expect(files()).toEqual(["vault-key"]);
    expect(envVaultKeySaved()).toBe(true);
  });

  it("another key: refused without --force; with it, backed up, then replaced", async () => {
    vi.stubEnv("ENGRAM_VAULT_KEY", ENV_KEY);
    writeFileSync(KEY_FILE, `${KEY}\n`, { mode: 0o600 });
    await expect(vaultSaveKey({})).rejects.toThrow("exit 1");
    expect(errs).toEqual([
      "~/.engram/vault-key holds a different vault key.",
      "Secrets encrypted with it can only be read with it. To replace it all the same,",
      "run this again with --force: the key in the file is backed up first.",
    ]);
    expect(out).toEqual([]);
    expect(readFileSync(KEY_FILE, "utf-8")).toBe(`${KEY}\n`);
    expect(files()).toEqual(["vault-key"]);

    exits = [];
    await vaultSaveKey({ force: "" });
    expect(exits).toEqual([]);
    const backups = files().filter((name) => name.startsWith("vault-key.bak-"));
    expect(backups).toHaveLength(1);
    const backup = join(ENGRAM, backups[0]);
    expect(readFileSync(backup, "utf-8")).toBe(`${KEY}\n`);
    if (posix) expect(lstatSync(backup).mode & 0o777).toBe(0o600);
    expect(readFileSync(KEY_FILE, "utf-8")).toBe(`${ENV_KEY}\n`);
    expect(out).toEqual([`Previous key backed up to ${backup}`, ...SAVED]);
    neverPrinted();
  });

  it("a folder in its place: refused, with --force too, and nothing in it touched", async () => {
    vi.stubEnv("ENGRAM_VAULT_KEY", ENV_KEY);
    mkdirSync(KEY_FILE);
    writeFileSync(join(KEY_FILE, "keep"), "kept");
    for (const flags of [{}, { force: "" }] as Array<Record<string, string>>) {
      errs = [];
      await expect(vaultSaveKey(flags)).rejects.toThrow("exit 1");
      expect(errs).toEqual(
        REFUSED(
          "is a folder, not a file",
          "Move the folder aside, and put your vault key back in ~/.engram/vault-key.",
        ),
      );
    }
    expect(files()).toEqual(["vault-key"]);
    expect(readdirSync(KEY_FILE)).toEqual(["keep"]);
    expect(out).toEqual([]);
  });

  unreadableIt("mode 000: refused, with --force too, and the key in it kept", async () => {
    vi.stubEnv("ENGRAM_VAULT_KEY", ENV_KEY);
    writeFileSync(KEY_FILE, `${KEY}\n`, { mode: 0o600 });
    chmodSync(KEY_FILE, 0o000);
    await expect(vaultSaveKey({ force: "" })).rejects.toThrow("exit 1");
    expect(errs).toEqual(
      REFUSED("can't be read: permission denied", "Make it readable with: chmod 600 ~/.engram/vault-key"),
    );
    expect(files()).toEqual(["vault-key"]);
    chmodSync(KEY_FILE, 0o600);
    expect(readFileSync(KEY_FILE, "utf-8")).toBe(`${KEY}\n`);
  });

  it("an empty file: replaced, with nothing in it to back up", async () => {
    vi.stubEnv("ENGRAM_VAULT_KEY", ENV_KEY);
    writeFileSync(KEY_FILE, "\n", { mode: 0o600 });
    await vaultSaveKey({});
    expect(exits).toEqual([]);
    expect(out).toEqual(SAVED);
    expect(files()).toEqual(["vault-key"]);
    expect(readFileSync(KEY_FILE, "utf-8")).toBe(`${ENV_KEY}\n`);
  });

  it("a daemon running, from before engram#693: it read its key when it started, and how to start it again with this one", async () => {
    vi.stubEnv("ENGRAM_VAULT_KEY", ENV_KEY);
    const stop = await daemonAnswering();
    try {
      await vaultSaveKey({});
    } finally {
      await stop();
    }
    expect(out).toEqual([...SAVED, ...RESTART]);
  });

  it("a daemon too busy to answer, or one only its PID file names: running all the same", async () => {
    vi.stubEnv("ENGRAM_VAULT_KEY", ENV_KEY);
    const stop = await daemonBusy();
    try {
      await vaultSaveKey({});
    } finally {
      await stop();
    }
    expect(out).toEqual([...SAVED, ...RESTART]);

    // One from before engram#612, which has no socket.
    out = [];
    rmSync(KEY_FILE);
    pidFileDaemon.pid = 4242;
    await vaultSaveKey({});
    expect(out).toEqual([...SAVED, ...RESTART]);
  });

  it("a daemon stopping, or none: nothing about starting it again", async () => {
    vi.stubEnv("ENGRAM_VAULT_KEY", ENV_KEY);
    const stop = await daemonAnswering({ stopping: true });
    try {
      await vaultSaveKey({});
    } finally {
      await stop();
    }
    expect(out).toEqual(SAVED);

    out = [];
    rmSync(KEY_FILE);
    await vaultSaveKey({});
    expect(out).toEqual(SAVED);
  });
});

describe("the daemon running now, after a key is saved (engram#693)", () => {
  const REREAD = "The daemon running now reads it before its next send: no restart needed.";
  const ENV = "The daemon running now was started with ENGRAM_VAULT_KEY, which it uses instead of the file.";
  const STATUS_FILE = join(ENGRAM, "status.json");

  /**
   * What save-key, then keygen --save, say of the daemon running now: the
   * lines after the two that say where the key went, and keygen's after
   * the key's fingerprint (engram#699). `daemon`: what answers.
   */
  async function hints(daemon: () => Promise<() => Promise<void>>): Promise<{ saved: string[]; made: string[] }> {
    vi.stubEnv("ENGRAM_VAULT_KEY", ENV_KEY);
    // No key there, so neither is refused.
    rmSync(KEY_FILE, { force: true });
    const stop = await daemon();
    try {
      await vaultSaveKey({});
      const saved = out.slice(2);
      out = [];
      rmSync(KEY_FILE);
      await vaultKeygen([], { save: "" });
      // Up to the blank line before how to use the key.
      expect(out[2]).toMatch(/^Key fingerprint: [0-9a-f]{8}$/);
      return { saved, made: out.slice(3, out.indexOf("")) };
    } finally {
      await stop();
    }
  }

  it("one that reads its key again: from its next send on, with no restart", async () => {
    expect(await hints(() => daemonAnswering({ reread: true }))).toEqual({ saved: [REREAD], made: [REREAD] });
    // Its status says it read its key from the file, or that it has none.
    for (const vaultKey of ["file", null]) {
      out = [];
      writeFileSync(STATUS_FILE, JSON.stringify({ health: "healthy", vault_key: vaultKey }));
      expect(await hints(() => daemonAnswering({ reread: true })), String(vaultKey)).toEqual({
        saved: [REREAD],
        made: [REREAD],
      });
    }
  });

  it("one started with ENGRAM_VAULT_KEY: it goes on with that one, whatever the file holds", async () => {
    writeFileSync(STATUS_FILE, JSON.stringify({ health: "healthy", vault_key: "env" }));
    expect(await hints(() => daemonAnswering({ reread: true }))).toEqual({ saved: [ENV], made: [ENV] });
  });

  it("one from before, or one too busy to say which: how to start it again, for a key just made too", async () => {
    const restart = {
      saved: [
        "The daemon running now read its key when it started. If that was without this one,",
        "as at login, run 'engram stop', then 'engram start'.",
      ],
      made: [
        "The daemon running now read its key when it started. For it to use this one,",
        "run 'engram stop', then 'engram start'.",
      ],
    };
    expect(await hints(() => daemonAnswering())).toEqual(restart);
    out = [];
    expect(await hints(daemonBusy)).toEqual(restart);
    // Its status, from a daemon that read its key again, says nothing of this one.
    out = [];
    writeFileSync(STATUS_FILE, JSON.stringify({ health: "healthy", vault_key: "env" }));
    expect(await hints(() => daemonAnswering())).toEqual(restart);
  });

  it("one stopping, or none: nothing about it", async () => {
    expect(await hints(() => daemonAnswering({ stopping: true, reread: true }))).toEqual({ saved: [], made: [] });
    out = [];
    expect(await hints(async () => async () => {})).toEqual({ saved: [], made: [] });
  });
});

describe("vault keygen: saving the key for the daemon at login (engram#690)", () => {
  it("not saved: how to save it, after how to set ENGRAM_VAULT_KEY", async () => {
    await vaultKeygen([], {});
    expect(out.slice(-3)).toEqual([
      "Usage with environment variable:",
      `  export ENGRAM_VAULT_KEY="<the key above>"`,
      "  Then 'engram vault save-key' saves it for the daemon started at login.",
    ]);
  });

  it("saved: nothing about save-key", async () => {
    await vaultKeygen([], { save: "" });
    expect(out.join("\n")).not.toContain("save-key");
  });
});
