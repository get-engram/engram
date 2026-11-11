import { statSync } from "node:fs";
import { homedir } from "node:os";
import { engramCommand } from "./package-runner.js";

/**
 * engram#653 — capture is the user's own: the daemon runs as the user, and
 * start at login is set up in the user's session. Run as root for the user
 * (`sudo engram …`), it would be set up for root instead:
 *
 * - macOS: root has no login session (`launchctl bootstrap gui/0` fails),
 *   and `launchctl load` run as root can load the job into the system
 *   domain, where the daemon runs as root.
 * - Linux: `systemctl --user` reaches root's user manager, not the user's.
 * - Everywhere: a daemon running as root in the user's ~/.engram makes files
 *   there, its database among them, that the user's own daemon can't write.
 */
export interface RootCheck {
  platform?: NodeJS.Platform;
  /** The effective uid: undefined on Windows. */
  euid?: number;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Who owns `path`: null when it can't be looked at. */
  ownerOf?: (path: string) => number | null;
}

function owner(path: string): number | null {
  try {
    return statSync(path).uid;
  } catch {
    return null;
  }
}

/** A uid, from sudo or pkexec, of someone other than root. */
function otherUid(value: string | undefined): boolean {
  return value !== undefined && /^\d+$/.test(value) && Number(value) !== 0;
}

/**
 * Whether this is root running Engram for someone else: on macOS, any root;
 * elsewhere, root through sudo (SUDO_UID, which run0 sets too), pkexec
 * (PKEXEC_UID) or doas (DOAS_USER), or root with a home directory another
 * user owns. Root that is the user, on a server people sign in to as root
 * or in a container, still gets capture. Never on Windows: there is no
 * root there, and the usual elevated prompt runs as the user's own account.
 */
export function rootForAnotherUser({
  platform = process.platform,
  euid = process.geteuid?.(),
  env = process.env,
  home = homedir(),
  ownerOf = owner,
}: RootCheck = {}): boolean {
  if (platform === "win32" || euid !== 0) return false;
  if (platform === "darwin") return true;
  if (otherUid(env.SUDO_UID) || otherUid(env.PKEXEC_UID)) return true;
  if (env.DOAS_USER && env.DOAS_USER !== "root") return true;
  const uid = ownerOf(home);
  return uid !== null && uid !== 0;
}

/**
 * What a command run as root for someone else says (engram#682): only
 * `engram help` and `engram version` run. On macOS, sudo keeps HOME, so
 * a command run with sudo wrote the user's ~/.engram as root, leaving
 * files there they can't read or change: config.json from login, signup,
 * auth, exclude, stop and uninstall, the vault key from `vault keygen
 * --save` and `vault save-key`, and the notice from `vault set` and
 * `vault delete` that the vault changed.
 * On Linux it set Engram up for root instead. `cmd`: the command's words,
 * as the CLI parsed them, without its arguments.
 */
export function asRootRefusal(cmd: string): { problem: string; fix: string } {
  const fix = `  Run '${engramCommand(cmd)}' as yourself, without sudo.`;
  switch (cmd.replace(/^daemon /, "")) {
    case "install":
      return { problem: "Start at login is per user, and this is running as root.", fix };
    case "start":
      return { problem: "Engram's daemon runs as you, and this is running as root.", fix };
    case "stop":
      // One started with sudo is root's: it says what stops that (engram#680).
      return {
        problem: "Engram runs as you, and this is running as root.",
        fix: `${fix} For a daemon started with sudo, it says what stops it.`,
      };
    default:
      return { problem: "Engram runs as you, and this is running as root.", fix };
  }
}
