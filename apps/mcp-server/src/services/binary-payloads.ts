/**
 * Base64 payloads in message bodies — screenshots, PDFs and other
 * attachments (engram#386).
 *
 * Captured conversations carry files as base64 text: a Claude Code tool
 * result is a JSON array whose image block holds the encoded screenshot,
 * MCP image content has a `data` field, and pages paste `data:` URLs.
 * Treated as text, that payload broke three things on the write path:
 *
 *  - the per-message clip (MAX_MESSAGE_CONTENT_CHARS) counted it as text,
 *    so one screenshot pushed everything written after it off the end;
 *  - the redactor's generic token net cannot tell a JPEG from a leaked
 *    key, so the image became "[REDACTED]" with nothing to say what it was;
 *  - the indexing estimate counted the encoded bytes as prose, charging
 *    ~50 chunks for a screenshot that embeds as one.
 *
 * So a payload is recognised by structure — a data: URL, a base64 run
 * whose first decoded bytes are a known file signature, or a run far
 * longer than any credential — and replaced with a short note saying what
 * was there: "[image not stored: PNG, 312 KB]". The note has no quotes or
 * backslashes, so a JSON tool result stays valid JSON, and it is plain
 * text the redactor still scans like everything else.
 *
 * Replacing a run removes all of it, so nothing it held is ever stored.
 * Runs that could be a credential — shorter than GENERIC_MIN_CHARS with no
 * file signature, or joined to a neighbour by "_" or "-" the way vendor
 * keys are spelled — are left exactly as they were, for the redactor.
 *
 * Every pattern is one character class with one-character lookarounds and
 * bounded optional parts, so the scan is linear in the message length.
 */

/** The redactor's floor for a base64 token; shorter runs are never touched. */
const MIN_RUN_CHARS = 40;

/**
 * A run with no file signature is replaced only past this length (about
 * 1.5 KB decoded). Below it a run may be a key or token, and the redactor
 * decides; nothing this long is a credential anyone types or pastes.
 */
export const GENERIC_MIN_CHARS = 2048;

/** 16 base64 characters decode to 12 bytes — enough for every signature. */
const SNIFF_CHARS = 16;

// A base64 run that stands alone: it starts after a character outside the
// alphabet (or after a JSON escape such as \n, so an encoded line break is
// a boundary, not part of the run) and is not glued to a neighbour by "_"
// or "-". Same alphabet and padding as the redactor's BASE64_TOKEN.
const BASE64_RUN =
  /(?:(?<![A-Za-z0-9+/_\\-])|(?<=\\[nrt]))[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/_-])/g;

// data:[<type>/<subtype>][;<param>]…;base64,<payload>
const DATA_URL =
  /data:(?:([a-z0-9.+-]{1,64})\/([a-z0-9.+-]{1,64}))?(?:;[a-z0-9.+=_-]{1,100}){0,4};base64,([A-Za-z0-9+/]{40,}={0,2})(?![A-Za-z0-9+/_-])/gi;

interface Payload {
  /** What the note calls it: "image", "PDF", "audio", "base64 data"… */
  kind: string;
  /** The file format when known, e.g. "PNG". */
  format?: string;
}

const GENERIC: Payload = { kind: "base64 data" };

const IMAGE_FORMATS = new Map<string, string>([
  ["png", "PNG"],
  ["jpeg", "JPEG"],
  ["jpg", "JPEG"],
  ["pjpeg", "JPEG"],
  ["gif", "GIF"],
  ["webp", "WebP"],
  ["svg+xml", "SVG"],
  ["bmp", "BMP"],
  ["avif", "AVIF"],
  ["heic", "HEIC"],
  ["heif", "HEIF"],
  ["tiff", "TIFF"],
  ["x-icon", "ICO"],
  ["vnd.microsoft.icon", "ICO"],
]);

/** The file type from the first decoded bytes, or null when unrecognised. */
function sniff(run: string): Payload | null {
  let head: string;
  try {
    head = atob(run.slice(0, SNIFF_CHARS));
  } catch {
    return null;
  }
  if (head.startsWith("\xFF\xD8\xFF")) return { kind: "image", format: "JPEG" };
  if (head.startsWith("\x89PNG\r\n\x1A\n")) return { kind: "image", format: "PNG" };
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) {
    return { kind: "image", format: "GIF" };
  }
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") {
    return { kind: "image", format: "WebP" };
  }
  if (head.startsWith("%PDF-")) return { kind: "PDF" };
  return null;
}

/** What a data: URL's declared media type says it is. */
function fromMediaType(type: string | undefined, subtype: string | undefined): Payload | null {
  if (!type || !subtype) return null;
  const t = type.toLowerCase();
  const s = subtype.toLowerCase();
  if (t === "image") return { kind: "image", format: IMAGE_FORMATS.get(s) };
  if (t === "application" && s === "pdf") return { kind: "PDF" };
  if (t === "audio" || t === "video" || t === "font") return { kind: t };
  return null;
}

/**
 * Real encoded files mix upper case, lower case and digits; a long run of
 * one repeated character or a single-case word is something else.
 */
function looksEncoded(run: string): boolean {
  return /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run);
}

function decodedBytes(payload: string): number {
  const pad = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.floor(((payload.length - pad) * 3) / 4);
}

/** Same scale as the CLI's "[image attached: …]" note. */
function formatSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function note(payload: Payload, encoded: string): string {
  const format = payload.format ? `${payload.format}, ` : "";
  return `[${payload.kind} not stored: ${format}${formatSize(decodedBytes(encoded))}]`;
}

/**
 * Replace every base64 file payload in `text` with a short note saying
 * what it was and how big. Text with no payload comes back unchanged
 * (the same string).
 */
export function stripBinaryPayloads(text: string): string {
  if (text.length < MIN_RUN_CHARS) return text;
  return text
    .replace(
      DATA_URL,
      (_url, type: string | undefined, subtype: string | undefined, payload: string) =>
        note(sniff(payload) ?? fromMediaType(type, subtype) ?? GENERIC, payload),
    )
    .replace(BASE64_RUN, (run) => {
      const found =
        sniff(run) ?? (run.length >= GENERIC_MIN_CHARS && looksEncoded(run) ? GENERIC : null);
      return found ? note(found, run) : run;
    });
}
