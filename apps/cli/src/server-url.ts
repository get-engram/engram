/**
 * The Engram server's address, and when two addresses name the same server
 * (engram#685). A module of its own, without config.json's code, so the
 * daemon's modules and their tests can use it whatever they load or mock.
 */

/** The server used when neither ENGRAM_BASE_URL nor config.json names one. */
export const DEFAULT_BASE_URL = "https://mcp.getengram.app";

/**
 * One spelling of a server address: scheme and host in lower case, without
 * a default port, a trailing slash, credentials, a query or a fragment. Two
 * addresses with the same spelling here are the same server. Something that
 * isn't a URL is only trimmed.
 */
export function normalizeServer(server: string): string {
  const trimmed = server.trim();
  try {
    const url = new URL(trimmed);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

/** Whether `server` is the default server, however it is spelled. */
export function isDefaultServer(server: string): boolean {
  return normalizeServer(server) === normalizeServer(DEFAULT_BASE_URL);
}

/** Whether `a` and `b` are the same server, however each is spelled. */
export function sameServer(a: string, b: string): boolean {
  return normalizeServer(a) === normalizeServer(b);
}

/**
 * The server the CLI and the daemon talk to: ENGRAM_BASE_URL, then baseUrl
 * in config.json, then the default (docs/cli.md). Everything that sends a
 * key, checks one or signs in for one resolves it here (engram#625).
 * `engram auth login` checked keys against the default server whatever was
 * configured, and the account commands skipped config.json, so a key could
 * be checked or minted on one server, used on another, and sent to a server
 * the user hadn't configured.
 */
export function resolveBaseUrl(config: { baseUrl?: unknown }): string {
  const configured =
    typeof config.baseUrl === "string" && config.baseUrl.trim() !== "" ? config.baseUrl.trim() : undefined;
  // An empty ENGRAM_BASE_URL names no server, as an empty baseUrl doesn't.
  const env = process.env.ENGRAM_BASE_URL?.trim() || undefined;
  return (env ?? configured ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}
