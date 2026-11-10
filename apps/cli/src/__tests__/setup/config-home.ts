import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// On Linux, `engram install` writes a systemd user unit to
// $XDG_CONFIG_HOME/systemd/user and `engram uninstall` removes it
// (engram#615). Every test file gets a temporary XDG_CONFIG_HOME, so that no
// test reads or removes the real one, whatever it mocks: a test of
// uninstall run on a Linux machine with Engram set up would otherwise turn
// off that machine's own start at login.
const dir = mkdtempSync(join(tmpdir(), "engram-test-config-"));
process.env.XDG_CONFIG_HOME = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Nor does any get the vault key of the shell that runs them: the CLI warns
// when ~/.engram/vault-key doesn't hold it (engram#690), and starts the
// daemon another way. A test that needs one sets its own.
delete process.env.ENGRAM_VAULT_KEY;
