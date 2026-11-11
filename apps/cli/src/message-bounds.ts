/**
 * Message bodies bounded the way Engram bounds them before it stores them
 * (engram#750): base64 file payloads become a short note, then the text is
 * clipped to MAX_MESSAGE_CONTENT_CHARS with a visible marker.
 *
 * Engram does this to every message it receives (engram#386), so doing it
 * here first stores the same text, with one exception that only ever
 * stores less: an encoded run glued to the next word by "_" or "-" is left
 * alone, but when the clip cuts it the run ends at the cut, and Engram's
 * own pass then replaces it with a note. What doing it here changes is
 * what travels and waits. A screenshot in a tool result was queued in
 * daemon.db and uploaded as megabytes of base64, only to be replaced by a
 * note on arrival, and one message past the server's 8 MB request limit
 * was refused on every try.
 *
 * This is a copy of the worker's code, not an import: the worker's lives in
 * @getengram/shared and apps/mcp-server, which are never published, and the
 * CLI depends only on @getengram/sdk. A test runs both copies over the same
 * inputs and fails the moment they differ, so change them together:
 *   apps/mcp-server/src/services/binary-payloads.ts  stripBinaryPayloads
 *   apps/mcp-server/src/services/tier.ts             boundContent
 *   packages/shared/src/constants.ts                 MAX_MESSAGE_CONTENT_CHARS
 */

/** Engram's per-message clip, in characters. */
export const MAX_MESSAGE_CONTENT_CHARS = 100_000;

/**
 * What Engram appends to a clipped body. Spelled out rather than built with
 * toLocaleString(), which follows the user's locale ("100.000" in German);
 * the worker's always reads "100,000".
 */
export const TRUNCATION_MARKER = "\n\n…[truncated: message exceeded 100,000 characters]";

/**
 * Bound one message body exactly as Engram's append does: file payloads
 * replaced with a note, then the text clipped with a visible marker. A body
 * with nothing to bound comes back unchanged (the same string).
 */
export function boundContent(content: string): string {
  const text = stripBinaryPayloads(content);
  if (text.length <= MAX_MESSAGE_CONTENT_CHARS) return text;
  return text.slice(0, MAX_MESSAGE_CONTENT_CHARS) + TRUNCATION_MARKER;
}

// ---------------------------------------------------------------------------
// From here on, a copy of apps/mcp-server/src/services/binary-payloads.ts.
// ---------------------------------------------------------------------------

/** The redactor's floor for a base64 token; shorter runs are never touched. */
const MIN_RUN_CHARS = 40;

/**
 * A run with no file signature is replaced only past this length (about
 * 1.5 KB decoded). Below it a run may be a key or token, and Engram's
 * redactor decides; nothing this long is a credential anyone types or pastes.
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

/** Same scale as the "[image attached: …]" note (daemon/parser.ts). */
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
 * what it was and how big: "[image not stored: PNG, 312 KB]". The note has
 * no quotes or backslashes, so a JSON tool result stays valid JSON. Runs
 * that could be a credential are left exactly as they were, for Engram's
 * redactor. Text with no payload comes back unchanged (the same string).
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
