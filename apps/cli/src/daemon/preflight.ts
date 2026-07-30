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
 * Strategy: try to load; on an ABI mismatch, run `npm rebuild
 * better-sqlite3` in the package that owns it (better-sqlite3 ships
 * prebuilds for common ABIs, so this is usually a quick download, not a
 * compile) and try once more. Returns true when the module loads; false
 * after printing the exact manual fix when it can't.
 */
export function ensureNativeSqlite(
  log: (msg: string) => void = (m) => console.error(m),
): boolean {
  try {
    req("better-sqlite3");
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
      req("better-sqlite3");
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
