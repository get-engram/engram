/**
 * What Windows runs at sign-in once start at login is on (engram#602). The
 * per-user Run entry is `"…\node.exe" "…\dist\daemon\login-start.js"`.
 *
 * node.exe is a console program, so whatever it runs at sign-in gets a
 * console window, and closing that window would end the daemon. So this
 * starts the worker detached and hidden, as `engram start` does, and exits:
 * the window only flashes.
 *
 * It starts the worker without consulting the PID file. Signing out ends
 * every program the user was running, so no daemon is up at sign-in; the
 * file is left over from the last session, and its PID may since have gone
 * to another program, which a liveness check would take for the daemon and
 * skip the start. The new worker writes its own PID over it.
 *
 * It never touches config. Like the macOS launchd agent, the entry runs at
 * every sign-in until `engram uninstall` removes it.
 *
 * Import-light, like worker.ts: see launch.ts.
 */
import { spawnWorker } from "./launch.js";

spawnWorker();
