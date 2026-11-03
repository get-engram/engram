/**
 * Webhook destination policy (engram#448).
 *
 * A webhook URL is the one place a customer hands us an address and we then
 * connect to it from our own egress, signed as us. That is the textbook SSRF
 * shape, so the destination is validated twice: when it is registered, and
 * again every time it is fired, because a row written before this policy
 * existed (or edited by hand) must not be grandfathered into a fetch.
 *
 * Allowed: https, to a public hostname with a real top-level label, on the
 * default port. Refused, and why:
 *
 * - any scheme but https — a cleartext receiver leaks the signed payload in
 *   transit, and "open a TCP connection to port N and speak HTTP at it" is
 *   exactly the primitive that makes an SSRF useful against non-HTTP
 *   services (Redis, memcached, SMTP).
 * - credentials in the URL — they would sit in plain text in D1 and travel
 *   in an Authorization header on every delivery.
 * - IP literals that are not globally routable: loopback, RFC 1918,
 *   link-local (which is where cloud metadata services live), CGNAT, the
 *   benchmarking and documentation blocks, multicast, and the IPv6 forms
 *   that embed an IPv4 address (mapped, compatible, NAT64, 6to4, Teredo).
 *   The WHATWG URL parser canonicalises the usual obfuscations before we
 *   look (decimal `2130706433`, hex `0x7f000001`, short `127.1` all become
 *   `127.0.0.1`), so the checks see dotted quads and expanded groups.
 * - hostnames that only mean something inside a private network: single
 *   labels, `localhost`, and the special-use suffixes.
 * - any port but 443 — a webhook receiver lives on the default https port;
 *   an arbitrary port turns the feature into a port scanner.
 *
 * The Workers runtime has no private network of ours behind it, so the
 * realistic impact of a hole here is "Engram as a signed-request proxy to
 * whatever Cloudflare's egress can reach", not credential theft. The policy
 * is enforced in full regardless: it costs nothing, and no live endpoint
 * existed when it shipped, so nothing legitimate was cut off.
 */

export const WEBHOOK_URL_MAX_LENGTH = 2048;

/** Active endpoints an organization may hold. Every event fans out to all of them. */
export const WEBHOOK_MAX_PER_ORG = 10;

/** A receiver that has not answered by then is a failed delivery, not a hung worker. */
export const WEBHOOK_DELIVERY_TIMEOUT_MS = 10_000;

export type WebhookUrlVerdict = { ok: true; url: string } | { ok: false; reason: string };

const refuse = (reason: string): WebhookUrlVerdict => ({ ok: false, reason });

/** Names that only ever mean "this machine" or a cloud metadata service. */
const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata",
  "instance-data",
  "metadata.google.internal",
  "kubernetes.default.svc",
]);

/**
 * Special-use and private-network suffixes (RFC 6761, RFC 6762, RFC 8375,
 * RFC 2606, plus the usual corporate conventions). None resolves on the
 * public internet, so there is no legitimate receiver behind any of them.
 */
const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".private",
  ".corp",
  ".home",
  ".lan",
  ".svc",
  ".arpa",
  ".test",
  ".example",
  ".invalid",
  ".onion",
];

/** LDH labels, 1–63 chars, no leading/trailing hyphen; the parser has already lowercased and punycoded. */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function validateWebhookUrl(raw: unknown): WebhookUrlVerdict {
  if (typeof raw !== "string" || raw.trim() === "") return refuse("url is required");
  if (raw.length > WEBHOOK_URL_MAX_LENGTH) {
    return refuse(`url must be at most ${WEBHOOK_URL_MAX_LENGTH} characters`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse("url must be an absolute URL");
  }
  if (url.protocol !== "https:") return refuse("url must use https");
  if (url.username !== "" || url.password !== "") return refuse("url must not embed credentials");
  // `port` is "" when the URL uses the scheme's default, so an explicit :443
  // passes and anything else is refused.
  if (url.port !== "") return refuse("url must use the default https port");

  const host = url.hostname;
  if (host.startsWith("[")) {
    const groups = parseIpv6(host.slice(1, -1));
    if (!groups || !isPublicIpv6(groups)) return refuse("url host must be a public address");
    return { ok: true, url: url.href };
  }
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    if (!isPublicIpv4(a, b, c, d)) return refuse("url host must be a public address");
    return { ok: true, url: url.href };
  }

  const name = host.endsWith(".") ? host.slice(0, -1) : host;
  if (!HOSTNAME_RE.test(name)) return refuse("url host is not a valid hostname");
  if (!name.includes(".")) return refuse("url host must be a fully qualified domain name");
  if (/^\d+$/.test(name.slice(name.lastIndexOf(".") + 1))) {
    return refuse("url host is not a valid hostname");
  }
  if (BLOCKED_HOSTS.has(name) || BLOCKED_SUFFIXES.some((s) => name.endsWith(s))) {
    return refuse("url host must be reachable on the public internet");
  }
  return { ok: true, url: url.href };
}

/** Globally routable IPv4, per the IANA special-purpose registry. */
export function isPublicIpv4(a: number, b: number, c: number, d: number): boolean {
  if ([a, b, c, d].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (a === 0 || a === 10 || a === 127) return false; // this-network, RFC 1918, loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
  if (a === 169 && b === 254) return false; // link-local, incl. 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC 1918
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF assignments, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay anycast
  if (a === 192 && b === 168) return false; // RFC 1918
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking 198.18/15
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/**
 * Expand an IPv6 literal (without brackets) to its eight 16-bit groups, or
 * null when it is not one. Accepts the `::` shorthand and an embedded
 * dotted-quad tail (`::ffff:10.0.0.1`), which becomes the last two groups.
 */
export function parseIpv6(text: string): number[] | null {
  let s = text.toLowerCase();
  if (s.includes("%")) return null; // zone ids never belong in a URL
  const tail = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return null;
    s = s.slice(0, tail.index) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  if (!head || !rest) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - rest.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...rest];
}

/** Globally routable IPv6: only 2000::/3, minus the blocks that embed or alias a non-public address. */
export function isPublicIpv6(g: number[]): boolean {
  if (g.length !== 8) return false;
  const zeroPrefix = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroPrefix(7)) return false; // :: and ::1
  if (zeroPrefix(5)) {
    // ::ffff:a.b.c.d (IPv4-mapped) is judged as its IPv4; ::a.b.c.d
    // (deprecated IPv4-compatible) and anything else under ::/80 is refused.
    return g[5] === 0xffff && isPublicIpv4(g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff);
  }
  if (g[0] === 0x64 && g[1] === 0xff9b) return false; // 64:ff9b::/96 and 64:ff9b:1::/48 NAT64
  if (g[0] === 0x2002) return isPublicIpv4(g[1] >> 8, g[1] & 0xff, g[2] >> 8, g[2] & 0xff); // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return false; // Teredo, embeds a v4 we cannot vet
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if ((g[0] & 0xfe00) === 0xfc00) return false; // ULA fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return false; // link-local
  if ((g[0] & 0xffc0) === 0xfec0) return false; // site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return false; // multicast
  return (g[0] & 0xe000) === 0x2000; // global unicast 2000::/3
}
