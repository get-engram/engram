const REDACTED = "[REDACTED]";

// --- Pattern definitions ---

// Generic high-entropy tokens: hex ≥32 chars, base64-ish ≥40 chars
const HEX_TOKEN = /\b[0-9a-fA-F]{32,}\b/g;
const BASE64_TOKEN = /\b[A-Za-z0-9+/]{40,}={0,2}\b/g;

// Provider API keys — each has a distinctive prefix
const PROVIDER_KEYS = [
  // OpenAI
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  // Anthropic
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  // AWS
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  // GitHub
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g,
  // Stripe
  /\b[rs]k_(test|live)_[A-Za-z0-9]{10,}\b/g,
  // Cloudflare
  /\bcfk_[A-Za-z0-9]{30,}\b/g,
  // Supabase
  /\bsbp_[A-Za-z0-9]{30,}\b/g,
  // Slack
  /\bxox[bpras]-[A-Za-z0-9-]{10,}\b/g,
  // npm
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  // Sendgrid
  /\bSG\.[A-Za-z0-9_-]{22,}\.[A-Za-z0-9_-]{22,}\b/g,
  // Twilio
  /\bSK[0-9a-fA-F]{32}\b/g,
  // Generic Bearer tokens on a single line
  /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/g,
];

// Connection strings (postgres, mysql, redis, mongodb, amqp)
const CONNECTION_STRING =
  /\b(postgres|postgresql|mysql|redis|rediss|mongodb|mongodb\+srv|amqp|amqps):\/\/[^\s"'`]+/gi;

// Private keys (PEM blocks)
const PRIVATE_KEY =
  /-----BEGIN\s+(RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END\s+(RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g;

// Key=value assignments where key suggests a secret
// Allows prefixes like DB_PASSWORD, STRIPE_SECRET, etc.
const SECRET_ASSIGNMENT =
  /\b\w*(password|passwd|secret|token|api_key|apikey|api[-_]?secret|private[-_]?key|access[-_]?key|auth[-_]?token|client[-_]?secret|signing[-_]?key|encryption[-_]?key|jwt[-_]?secret)\s*[:=]\s*["']?[^\s"']{8,}["']?/gi;

// PII patterns
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const CREDIT_CARD = /\b(?:\d[ -]*?){13,19}\b/g;

// JWTs (three base64url segments separated by dots)
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

export interface RedactResult {
  text: string;
  redactionCount: number;
}

/**
 * Redact secrets, credentials, and PII from text.
 * Returns the cleaned text and a count of redactions applied.
 */
export function redact(input: string): RedactResult {
  let text = input;
  let count = 0;

  function apply(pattern: RegExp) {
    text = text.replace(pattern, () => {
      count++;
      return REDACTED;
    });
  }

  // Order matters — specific patterns first, then generic

  // 1. PEM private keys (multi-line)
  apply(PRIVATE_KEY);

  // 2. Provider-specific API keys
  for (const pat of PROVIDER_KEYS) {
    apply(pat);
  }

  // 3. JWTs
  apply(JWT);

  // 4. Connection strings
  apply(CONNECTION_STRING);

  // 5. Secret assignments (password=..., token:..., etc.)
  apply(SECRET_ASSIGNMENT);

  // 6. PII
  apply(SSN);
  apply(CREDIT_CARD);
  apply(EMAIL);
  apply(PHONE);

  // 7. Generic high-entropy tokens (last — catches stragglers)
  apply(HEX_TOKEN);
  apply(BASE64_TOKEN);

  return { text, redactionCount: count };
}

/**
 * Redact an array of message contents in place.
 * Returns total redaction count across all messages.
 */
export function redactMessages<T extends { content: string }>(
  messages: T[]
): { messages: T[]; totalRedactions: number } {
  let total = 0;
  const redacted = messages.map((m) => {
    const result = redact(m.content);
    total += result.redactionCount;
    return { ...m, content: result.text };
  });
  return { messages: redacted, totalRedactions: total };
}
