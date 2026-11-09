/**
 * Windows PowerShell, for what Node can't do by itself on Windows: show a
 * toast (status.ts, engram#614), and find out whose process a PID is and
 * what it runs (instance.ts, engram#640).
 *
 * Whatever varies, such as a title or a PID, goes to the script in an
 * environment variable, never into it, so nothing in it can become script.
 *
 * IMPORTANT: Node built-ins only. instance.ts imports this, and the worker
 * claims its lock through instance.ts before the native-module preflight
 * (see launch.ts).
 */

import { win32 } from "node:path";

/**
 * Windows PowerShell by its full path under the system root, never a
 * powershell.exe found on PATH or in the working directory. It ships with
 * every Windows 10 and 11.
 */
export function windowsPowerShellPath(systemRoot: string = process.env.SystemRoot || "C:\\Windows"): string {
  return win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * The arguments that run `statements`, one PowerShell statement each, with
 * no profile and never a prompt. The statements have no double quotes,
 * which the Windows command line would have to escape.
 */
export function powerShellArgs(statements: readonly string[]): string[] {
  return ["-NoProfile", "-NonInteractive", "-Command", statements.join("; ")];
}
