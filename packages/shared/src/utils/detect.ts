/**
 * Secret & PII detection with position tracking.
 * Returns match metadata instead of replacing — used by both
 * the SDK (client-side vault encryption) and the server (fallback redaction).
 */

export type SecretType =
  | "private_key"
  | "api_key"
  | "jwt"
  | "connection_string"
  | "secret_assignment"
  | "ssn"
  | "credit_card"
  | "email"
  | "phone"
  | "token";

export interface DetectedSecret {
  type: SecretType;
  value: string;
  start: number;
  end: number;
}

// --- Pattern definitions (shared with redact.ts) ---

const HEX_TOKEN = /\b[0-9a-fA-F]{32,}\b/g;
const BASE64_TOKEN = /\b[A-Za-z0-9+/]{40,}={0,2}\b/g;

const PROVIDER_KEYS: RegExp[] = [
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g,
  /\b[rs]k_(test|live)_[A-Za-z0-9]{10,}\b/g,
  /\bcfk_[A-Za-z0-9]{30,}\b/g,
  /\bsbp_[A-Za-z0-9]{30,}\b/g,
  /\bxox[bpras]-[A-Za-z0-9-]{10,}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  /\bSG\.[A-Za-z0-9_-]{22,}\.[A-Za-z0-9_-]{22,}\b/g,
  /\bSK[0-9a-fA-F]{32}\b/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/g,
];

const CONNECTION_STRING =
  /\b(postgres|postgresql|mysql|redis|rediss|mongodb|mongodb\+srv|amqp|amqps):\/\/[^\s"'`]+/gi;

const PRIVATE_KEY =
  /-----BEGIN\s+(RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END\s+(RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g;

const SECRET_ASSIGNMENT =
  /\b\w*(password|passwd|secret|token|api_key|apikey|api[-_]?secret|private[-_]?key|access[-_]?key|auth[-_]?token|client[-_]?secret|signing[-_]?key|encryption[-_]?key|jwt[-_]?secret)\s*[:=]\s*["']?[^\s"']{8,}["']?/gi;

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const CREDIT_CARD = /\b(?:\d[ -]*?){13,19}\b/g;
const JWT =
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

/**
 * Scan text for secrets and PII patterns. Returns non-overlapping matches
 * sorted by position (earliest first, longest wins on ties).
 */
export function detectSecrets(input: string): DetectedSecret[] {
  const matches: DetectedSecret[] = [];

  function scan(pattern: RegExp, type: SecretType) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(input)) !== null) {
      matches.push({
        type,
        value: match[0],
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  // Order: specific → generic (same as redact.ts)
  scan(PRIVATE_KEY, "private_key");
  for (const pat of PROVIDER_KEYS) scan(pat, "api_key");
  scan(JWT, "jwt");
  scan(CONNECTION_STRING, "connection_string");
  scan(SECRET_ASSIGNMENT, "secret_assignment");
  scan(SSN, "ssn");
  scan(CREDIT_CARD, "credit_card");
  scan(EMAIL, "email");
  scan(PHONE, "phone");
  scan(HEX_TOKEN, "token");
  scan(BASE64_TOKEN, "token");

  // Sort by start position; on tie, longer match wins
  matches.sort((a, b) => a.start - b.start || b.end - a.end);

  // Remove overlapping matches — keep first (most specific) at each position
  const deduped: DetectedSecret[] = [];
  let lastEnd = -1;
  for (const m of matches) {
    if (m.start >= lastEnd) {
      deduped.push(m);
      lastEnd = m.end;
    }
  }

  return deduped;
}
