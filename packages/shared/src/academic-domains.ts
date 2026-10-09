/**
 * Is this email address issued by a university? (engram#471)
 *
 * Shipping a list of every academic domain on earth is the obvious approach
 * and the wrong one: the public datasets run to ~10k entries, they go stale
 * the moment a university adds a subdomain, and they skew heavily American.
 * Ali Shah — the student who prompted this — writes from
 * `leomail.tamuc.edu`, a Texas A&M Commerce subdomain that a flat allowlist
 * would very likely miss.
 *
 * Instead we match the structure institutions actually use. Nearly every
 * country reserves a second-level domain for higher education:
 *
 *   .edu                 United States (and a handful of others)
 *   .ac.<cc>             UK, JP, KR, NZ, IN, ZA, IL, TH, ID, …
 *   .edu.<cc>            AU, CN, BR, MX, SG, HK, TW, TR, PL, …
 *
 * That covers the large majority with a few rules and no staleness, since it
 * matches any subdomain depth automatically. Countries whose universities use
 * ordinary national domains (Germany's uni-*.de, Switzerland's ethz.ch,
 * France's *.fr) can't be pattern-matched and are handled by EXTRA_DOMAINS
 * plus manual review — the long tail is a support question, not a code one.
 *
 * Deliberately NOT accepted: `.sch.*` and `.k12.*` (schools, not higher ed).
 */

/** Country codes that reserve `ac.<cc>` for higher education. */
const AC_CC = [
  "uk", "jp", "kr", "nz", "in", "za", "il", "at", "be", "th", "id", "ir",
  "cy", "rw", "ug", "tz", "ke", "lk", "ma", "cn", "ae", "bw", "mw", "mz",
  "zm", "zw", "fj", "pg", "mu", "na", "gm", "sl", "ls", "sz", "np", "bd",
  "pk", "my", "vn", "ph",
];

/** Country codes that reserve `edu.<cc>` for higher education. */
const EDU_CC = [
  "au", "cn", "br", "mx", "sg", "hk", "tw", "my", "ph", "pk", "in", "co",
  "ar", "pe", "ec", "uy", "ve", "tr", "pl", "gr", "es", "it", "vn", "sa",
  "eg", "jo", "lb", "kw", "qa", "om", "bh", "ng", "gh", "pt", "ru", "ua",
  "ae", "do", "gt", "sv", "hn", "ni", "cr", "pa", "bo", "py", "cl", "kz",
  "np", "bd", "lk", "mm", "kh", "la", "mn", "af", "iq", "ye", "sd", "ly",
  "tn", "dz", "et", "cm", "ci", "sn", "zm", "mt", "cu", "jm", "tt", "bs",
];

/**
 * Institutions that don't fit the pattern. Intentionally short — this is the
 * escape hatch, not the mechanism. Grow it from real support requests rather
 * than trying to pre-populate the world.
 */
const EXTRA_DOMAINS = new Set<string>([
  // Germany, Switzerland, Austria, France, Nordics — ordinary national TLDs
  "ethz.ch", "epfl.ch", "uzh.ch", "unibe.ch", "unibas.ch",
  "tum.de", "lmu.de", "rwth-aachen.de", "kit.edu", "hu-berlin.de",
  "fu-berlin.de", "tu-berlin.de", "uni-heidelberg.de", "uni-muenchen.de",
  "ku.dk", "dtu.dk", "lu.se", "kth.se", "chalmers.se", "uu.se",
  "uio.no", "ntnu.no", "helsinki.fi", "aalto.fi",
  "sorbonne-universite.fr", "polytechnique.edu", "ens.fr", "u-psud.fr",
  "uva.nl", "tudelft.nl", "ru.nl", "rug.nl", "leidenuniv.nl",
  "kuleuven.be", "ugent.be", "ulb.be",
  "unimi.it", "unibo.it", "polimi.it", "uniroma1.it",
  "tcd.ie", "ucd.ie", "universityofgalway.ie",
  "mcgill.ca", "utoronto.ca", "ubc.ca", "uwaterloo.ca", "ualberta.ca",
  "unam.mx", "itesm.mx", "tec.mx",
]);

/** Normalize to the bare lowercase domain. */
export function emailDomain(email: string): string | null {
  const addr = email.trim();
  // Whitespace anywhere means this isn't a plain address — reject rather than
  // silently accepting the domain half of something malformed, since we go on
  // to store this value and send mail to it.
  if (!addr || /\s/.test(addr)) return null;
  const at = addr.lastIndexOf("@");
  if (at < 1 || at === addr.length - 1) return null;
  const domain = addr.slice(at + 1).toLowerCase();
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith("."))
    return null;
  return domain;
}

/**
 * True when the address looks institutional. Matches at any subdomain depth,
 * so `cs.ox.ac.uk` and `leomail.tamuc.edu` both pass.
 */
export function isAcademicEmail(email: string): boolean {
  const domain = emailDomain(email);
  if (!domain) return false;

  // Schools, not higher education — checked first so `sch.uk`-style domains
  // can't slip through a later rule.
  if (/(^|\.)(sch|k12)\.[a-z]{2}$/.test(domain)) return false;

  if (domain === "edu" || domain.endsWith(".edu")) return true;

  for (const cc of AC_CC) if (domain.endsWith(`.ac.${cc}`)) return true;
  for (const cc of EDU_CC) if (domain.endsWith(`.edu.${cc}`)) return true;

  if (EXTRA_DOMAINS.has(domain)) return true;
  // A subdomain of a listed institution (mail.ethz.ch) still counts.
  for (const d of EXTRA_DOMAINS) if (domain.endsWith(`.${d}`)) return true;

  return false;
}
