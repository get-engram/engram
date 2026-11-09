/**
 * What Windows runs at sign-in once start at login is on (engram#602). The
 * per-user Run entry is `"…\node.exe" "…\dist\daemon\login-start.js"`.
 *
 * node.exe is a console program, so whatever it runs at sign-in gets a
 * console window, and closing that window would end the daemon. So this
 * starts the supervisor detached and hidden, as `engram start` does, and
 * exits: the window only flashes. The supervisor starts the worker, and
 * starts it again if it exits with an error (engram#613; see supervise.ts).
 *
 * It starts them without checking for a daemon. The worker does that
 * itself (engram#612): if a daemon already answers on its named pipe, it
 * exits at once. The PID file is never taken as a sign of one here.
 * Signing out ends every program the user was running, so a file left from
 * the last session names a PID that may since have gone to another program;
 * the new worker writes its own PID over it.
 *
 * It never touches config. Like the macOS launchd agent, the entry runs at
 * every sign-in until `engram uninstall` removes it.
 *
 * Import-light, like worker.ts: see launch.ts.
 */
import { spawnSupervisor } from "./launch.js";

spawnSupervisor();
