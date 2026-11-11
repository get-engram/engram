import { describe, it, expect } from "vitest";
import { redact, MAX_MESSAGE_CONTENT_CHARS } from "@getengram/shared";
import { stripBinaryPayloads, GENERIC_MIN_CHARS } from "../services/binary-payloads.js";
import { boundContent, estimateIndexingUnits } from "../services/tier.js";
import { boundMessageContent } from "../services/conversation.js";

/**
 * engram#386: a screenshot in a captured conversation is base64 text. It
 * used to reach the redactor whole (which turned it into "[REDACTED]"),
 * the per-message clip (which cut off everything written after it) and
 * the indexing estimate (which charged it as dozens of chunks). These pin
 * that every file payload becomes a short note first — and that anything
 * that could be a credential is still left for the redactor.
 */

/** Deterministic noise, so encoded payloads mix cases and digits like real files. */
function noise(length: number, seed = 7): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

/** A base64 file: `magic` followed by noise, `size` bytes in all. */
function encodedFile(magic: string | number[], size: number, seed?: number): string {
  const head = typeof magic === "string" ? Array.from(magic, (ch) => ch.charCodeAt(0)) : magic;
  const bytes = noise(size, seed);
  bytes.set(head);
  return Buffer.from(bytes).toString("base64");
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const GIF = "GIF89a";
const WEBP = "RIFF\x10\x27\x00\x00WEBP";
const PDF = "%PDF-1.7";

/** What the CLI sends for a Claude Code tool result that carries a screenshot. */
function screenshotToolResult(data: string, mediaType = "image/png"): string {
  return JSON.stringify([
    { type: "text", text: "Successfully captured screenshot (1184x1008, png)" },
    { type: "image", source: { type: "base64", media_type: mediaType, data } },
  ]);
}

describe("stripBinaryPayloads: file payloads become a note", () => {
  it("notes a screenshot in a tool result and keeps the JSON valid", () => {
    const shot = encodedFile(PNG, 240_000);
    const out = stripBinaryPayloads(screenshotToolResult(shot));
    const blocks = JSON.parse(out) as Array<{ text?: string; source?: { data: string } }>;
    expect(blocks[0].text).toBe("Successfully captured screenshot (1184x1008, png)");
    expect(blocks[1].source?.data).toBe("[image not stored: PNG, 234 KB]");
    expect(out.length).toBeLessThan(300);
  });

  it("names the format from the file's own bytes", () => {
    const cases: Array<[string | number[], string]> = [
      [JPEG, "[image not stored: JPEG, 49 KB]"],
      [GIF, "[image not stored: GIF, 49 KB]"],
      ["GIF87a", "[image not stored: GIF, 49 KB]"],
      // RIFF is also WAV and AVI: only the WEBP form is an image.
      ["RIFF\x10\x27\x00\x00WAVE", "[base64 data not stored: 49 KB]"],
      [WEBP, "[image not stored: WebP, 49 KB]"],
      [PNG, "[image not stored: PNG, 49 KB]"],
      [PDF, "[PDF not stored: 49 KB]"],
    ];
    for (const [magic, expected] of cases) {
      // MCP image content: {"type":"image","data":…,"mimeType":…}
      const block = JSON.stringify({ type: "image", data: encodedFile(magic, 50_000), mimeType: "x" });
      expect(JSON.parse(stripBinaryPayloads(block)).data).toBe(expected);
    }
  });

  it("notes a small image the redactor would have called a secret", () => {
    const icon = encodedFile(GIF, 60);
    expect(icon.length).toBeLessThan(GENERIC_MIN_CHARS);
    expect(stripBinaryPayloads(`icon: ${icon} done`)).toBe("icon: [image not stored: GIF, 60 B] done");
  });

  it("sizes a large document in MB", () => {
    const doc = JSON.stringify({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: encodedFile(PDF, 1_300_000) },
    });
    expect(JSON.parse(stripBinaryPayloads(doc)).source.data).toBe("[PDF not stored: 1.2 MB]");
  });

  it("replaces a whole data: URL, naming it by its bytes or its media type", () => {
    const webp = encodedFile(WEBP, 4_000);
    expect(stripBinaryPayloads(`![chart](data:image/webp;base64,${webp})`)).toBe(
      "![chart]([image not stored: WebP, 4 KB])",
    );
    // SVG is text, so there is no byte signature: the media type names it.
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${"<g/>".repeat(40)}</svg>`).toString(
      "base64",
    );
    expect(stripBinaryPayloads(`<img src="data:image/svg+xml;base64,${svg}">`)).toMatch(
      /^<img src="\[image not stored: SVG, \d+ B\]">$/,
    );
    expect(
      stripBinaryPayloads(`{"url":"data:application/pdf;charset=binary;base64,${encodedFile(PDF, 3_000)}"}`),
    ).toBe('{"url":"[PDF not stored: 3 KB]"}');
    expect(stripBinaryPayloads(`DATA:IMAGE/PNG;BASE64,${encodedFile(PNG, 2_048)}`)).toBe(
      "[image not stored: PNG, 2 KB]",
    );
    const blob = Buffer.from(noise(100)).toString("base64");
    expect(stripBinaryPayloads(`data:application/octet-stream;base64,${blob}`)).toBe(
      "[base64 data not stored: 100 B]",
    );
    expect(stripBinaryPayloads(`data:audio/wav;base64,${blob}`)).toBe("[audio not stored: 100 B]");
  });

  it("names a payload by its declared media type when its bytes don't say", () => {
    const blob = Buffer.from(noise(100)).toString("base64");
    const cases: Array<[string, string]> = [
      ["image/heic", "[image not stored: HEIC, 100 B]"],
      ["IMAGE/HEIC", "[image not stored: HEIC, 100 B]"],
      ["image/avif", "[image not stored: AVIF, 100 B]"],
      ["image/bmp", "[image not stored: BMP, 100 B]"],
      ["image/x-icon", "[image not stored: ICO, 100 B]"],
      ["image/x-something-new", "[image not stored: 100 B]"],
      ["application/pdf", "[PDF not stored: 100 B]"],
      ["video/mp4", "[video not stored: 100 B]"],
      ["font/woff2", "[font not stored: 100 B]"],
      ["text/plain", "[base64 data not stored: 100 B]"],
      ["", "[base64 data not stored: 100 B]"],
    ];
    for (const [type, expected] of cases) {
      expect(stripBinaryPayloads(`data:${type};base64,${blob}`)).toBe(expected);
    }
  });

  it("trusts the file's bytes over a mislabelled media type", () => {
    const jpeg = encodedFile(JPEG, 2_000);
    expect(stripBinaryPayloads(`data:image/png;base64,${jpeg}`)).toBe("[image not stored: JPEG, 2 KB]");
  });

  it("sizes the decoded file on the CLI's scale", () => {
    const cases: Array<[number, string]> = [
      [101, "101 B"],
      [1_023, "1023 B"],
      [1_024, "1 KB"],
      [1_048_575, "1024 KB"],
      [1_048_576, "1.0 MB"],
    ];
    for (const [bytes, size] of cases) {
      const blob = Buffer.from(noise(bytes)).toString("base64");
      expect(stripBinaryPayloads(`data:application/octet-stream;base64,${blob}`)).toBe(
        `[base64 data not stored: ${size}]`,
      );
    }
  });

  it("starts at 40 encoded characters, the same floor as the redactor", () => {
    const at = encodedFile(GIF, 30);
    const under = encodedFile(GIF, 27);
    expect(at).toHaveLength(40);
    expect(stripBinaryPayloads(`a ${at} b`)).toBe("a [image not stored: GIF, 30 B] b");
    expect(stripBinaryPayloads(`a ${under} b`)).toBe(`a ${under} b`);
    expect(stripBinaryPayloads(`data:image/gif;base64,${at}`)).toBe("[image not stored: GIF, 30 B]");
  });

  it("notes an unrecognised run from GENERIC_MIN_CHARS characters on", () => {
    const at = Buffer.from(noise(1_536)).toString("base64");
    const under = Buffer.from(noise(1_535)).toString("base64").replace(/=+$/, "");
    expect(at).toHaveLength(GENERIC_MIN_CHARS);
    expect(under).toHaveLength(GENERIC_MIN_CHARS - 1);
    expect(stripBinaryPayloads(` ${at} `)).toBe(" [base64 data not stored: 2 KB] ");
    expect(stripBinaryPayloads(` ${under} `)).toBe(` ${under} `);
  });

  it("notes a run far longer than any credential even with no known signature", () => {
    const blob = Buffer.from(noise(3_000)).toString("base64");
    expect(blob.length).toBeGreaterThanOrEqual(GENERIC_MIN_CHARS);
    expect(stripBinaryPayloads(`"payload":"${blob}"`)).toBe('"payload":"[base64 data not stored: 3 KB]"');
  });

  it("treats a JSON-escaped line break or tab as a boundary, not part of the payload", () => {
    const shot = encodedFile(PNG, 10_000);
    for (const sep of ["\n", "\r", "\t"]) {
      const content = JSON.stringify({ type: "text", text: `$ base64 shot.png${sep}${shot}${sep}` });
      const out = stripBinaryPayloads(content);
      expect(JSON.parse(out).text).toBe(`$ base64 shot.png${sep}[image not stored: PNG, 10 KB]${sep}`);
    }
  });

  it("keeps the words after a payload", () => {
    const shot = encodedFile(JPEG, 400_000);
    const out = stripBinaryPayloads(`before ${shot} after`);
    expect(out).toBe("before [image not stored: JPEG, 391 KB] after");
  });
});

describe("stripBinaryPayloads: credentials stay with the redactor", () => {
  it("leaves a key-sized base64 secret for the redactor", () => {
    const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const text = `aws_secret_access_key ${secret}`;
    expect(stripBinaryPayloads(text)).toBe(text);
    expect(redact(stripBinaryPayloads(text)).text).not.toContain(secret);
  });

  it("leaves an unrecognised run shorter than GENERIC_MIN_CHARS untouched", () => {
    const token = Buffer.from(noise(1_000)).toString("base64");
    expect(token.length).toBeLessThan(GENERIC_MIN_CHARS);
    const text = `token: ${token}`;
    expect(stripBinaryPayloads(text)).toBe(text);
    expect(redact(text).text).not.toContain(token);
  });

  it("never touches a run joined to a prefix the way vendor keys are spelled", () => {
    const body = Buffer.from(noise(3_000)).toString("base64").replace(/=+$/, "");
    for (const text of [`tok_${body}`, `key-${body}`, `${body}_suffix`, `${body}-x`]) {
      expect(stripBinaryPayloads(text)).toBe(text);
      expect(redact(text).text).not.toContain(body);
    }
    const png = encodedFile(PNG, 3_000);
    const glued = `data:image/png;base64,${png}_tail`;
    expect(stripBinaryPayloads(glued)).toBe(glued);
    expect(redact(glued).text).not.toContain(png);
  });

  it("leaves a JWT whole for the redactor's JWT pattern", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
      "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkphbmUgRXhhbXBsZSIsImlhdCI6MTUxNjIzOTAyMn0." +
      "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(stripBinaryPayloads(`Bearer ${jwt}`)).toBe(`Bearer ${jwt}`);
  });

  it("leaves text that only looks like base64 alone", () => {
    for (const text of [
      "x".repeat(100_000),
      "abc".repeat(5_000),
      "AbCd".repeat(1_000),
      "ab12".repeat(1_000),
      "AB12".repeat(1_000),
      "The quick brown fox jumps over the lazy dog. ".repeat(500),
      "see https://example.com/a/b/c?d=e and data: none",
      "",
    ]) {
      expect(stripBinaryPayloads(text)).toBe(text);
    }
  });

  it("does not inflate the redaction count with the screenshot", () => {
    const content = screenshotToolResult(encodedFile(JPEG, 120_000), "image/jpeg");
    expect(redact(content).redactionCount).toBeGreaterThan(0);
    expect(redact(stripBinaryPayloads(content)).redactionCount).toBe(0);
  });

  it("scans adversarial input in linear time", () => {
    const inputs = [
      `${"A".repeat(39)}_`.repeat(50_000),
      `${"A".repeat(5_000)}-`.repeat(400),
      "data:".repeat(200_000),
      `data:image/png${";a=b".repeat(10)};base64,`.repeat(20_000),
      "\\n".repeat(500_000),
    ];
    const started = Date.now();
    for (const text of inputs) expect(stripBinaryPayloads(text)).toBe(text);
    // Quadratic backtracking on any of these takes minutes, not seconds.
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("the write path bounds payloads before clipping and charging (engram#386)", () => {
  const shot = encodedFile(PNG, 300_000);
  const message = `${screenshotToolResult(shot)}\nThe save button is greyed out until the form is valid.`;

  it("keeps the text after a screenshot that is longer than the clip", () => {
    expect(message.length).toBeGreaterThan(MAX_MESSAGE_CONTENT_CHARS);
    const [out] = boundMessageContent([{ role: "user", content: message }]);
    expect(out.content).toContain("[image not stored: PNG, 293 KB]");
    expect(out.content).toContain("The save button is greyed out until the form is valid.");
    expect(out.content).not.toContain("truncated");
  });

  it("notes a screenshot in a short message too", () => {
    const small = screenshotToolResult(encodedFile(PNG, 30_000));
    expect(small.length).toBeLessThan(MAX_MESSAGE_CONTENT_CHARS);
    const [out] = boundMessageContent([{ role: "user", content: small }]);
    expect(out.content).toContain("[image not stored: PNG, 29 KB]");
  });

  it("returns a message with nothing to bound as the same object", () => {
    const input = { role: "user" as const, content: "remember this" };
    expect(boundMessageContent([input])[0]).toBe(input);
  });

  it("still clips text that is long after the payloads are gone", () => {
    const prose = "word ".repeat(30_000);
    const out = boundContent(`${shot} ${prose}`);
    expect(out.startsWith("[image not stored: PNG, 293 KB] word word")).toBe(true);
    expect(out).toContain("[truncated: message exceeded");
  });

  it("charges a screenshot as the note it is stored as, not as encoded text", () => {
    const units = estimateIndexingUnits([{ role: "user", content: message }]);
    expect(units).toBe(1);
    expect(units).toBe(
      estimateIndexingUnits([{ role: "user", content: stripBinaryPayloads(message) }]),
    );
  });
});
