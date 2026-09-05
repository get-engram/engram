/**
 * Two-letter country for the request, from Cloudflare's edge geolocation.
 * Present on every Worker request at no cost and with no lookup. "T1" is what
 * Cloudflare reports for Tor exits; treat it as unknown rather than a country.
 */
export function requestCountry(req: Request): string | null {
  const cf = (req as Request & { cf?: { country?: string } }).cf;
  const c = cf?.country;
  return c && c !== "T1" ? c : null;
}
