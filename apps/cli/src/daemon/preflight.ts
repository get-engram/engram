import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { dirname } from "node:path";

// IMPORTANT: this module must never import better-sqlite3 (or anything
// that does) statically — its whole job is to run before the native
// module loads and heal an ABI mismatch.

const req = createRequire(import.meta.url);

const ABI_MISMATCH =
  /NODE_MODULE_VERSION|was compiled against a different Node\.js version|ERR_DLOPEN_FAILED|invalid ELF header|is not a valid Win32 application/i;

/**
 * Make sure better-sqlite3 can actually load on this Node.
 *
 * The daemon's native module is compiled at install time against whatever
 * Node ran npm/brew. When the runtime Node changes (brew upgrades to a new
 * major, or the user switches between brew's Node and nvm's), the addon
 * throws an ABI-mismatch error and — before this preflight — the daemon
 * died silently in its log while `engram` commands that touch the local DB
 * crashed outright. Now that capture is on by default, that failure mode
 * has to self-heal.
 *
 * Strategy: try to OPEN a database; on an ABI mismatch, run `npm rebuild
 * better-sqlite3` in the package that owns it (better-sqlite3 ships
 * prebuilds for common ABIs, so this is usually a quick download, not a
 * compile) and try once more. Returns true when sqlite actually works;
 * false after printing the exact manual fix when it can't.
 *
 * Opening a database is the whole point, and the reason this function was
 * broken from the day it shipped. `require("better-sqlite3")` does NOT load
 * the native addon — the binding is resolved lazily, on first construction.
 * So the old check returned true on a machine whose addon could not load,
 * the heal never ran, and the daemon died a few lines later inside
 * worker-main with the exact error this was written to repair. The owner's
 * machine crashlooped that way 2,358 times over three weeks (engram#496).
 * Anything cheaper than `new Database(":memory:")` is not a real check.
 */
/**
 * Load the addon for real. An in-memory database touches no disk and is
 * closed immediately, so this is cheap — and unlike a bare require() it
 * actually dlopens the binary.
 */
function probeSqlite(): void {
  const Database = req("better-sqlite3") as new (path: string) => { close(): void };
  const db = new Database(":memory:");
  db.close();
}

export function ensureNativeSqlite(
  log: (msg: string) => void = (m) => console.error(m),
): boolean {
  try {
    probeSqlite();
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!ABI_MISMATCH.test(msg)) {
      throw err;
    }
    log(
      `better-sqlite3 was built for a different Node (now running ${process.version}) — rebuilding...`,
    );
    let ownerDir = "";
    try {
      const pkgDir = dirname(req.resolve("better-sqlite3/package.json"));
      // …/node_modules/better-sqlite3 → the package root that owns node_modules
      ownerDir = dirname(dirname(pkgDir));
      execSync("npm rebuild better-sqlite3", {
        cwd: ownerDir,
        stdio: "pipe",
        timeout: 180_000,
      });
      // Re-probe, not re-require: the failed module stays in require's
      // cache, so only a fresh open proves the rebuild took.
      delete req.cache?.[req.resolve("better-sqlite3")];
      probeSqlite();
      log("better-sqlite3 rebuilt for this Node — continuing.");
      return true;
    } catch {
      log(
        "Automatic rebuild failed. Fix manually with:\n" +
          `  cd ${ownerDir || "<the directory containing node_modules/better-sqlite3>"} && npm rebuild better-sqlite3\n` +
          "then run 'engram start' again.",
      );
      return false;
    }
  }
}
