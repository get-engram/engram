/**
 * Gzip compression for message content stored in D1.
 *
 * Uses the native CompressionStream / DecompressionStream APIs available in
 * Cloudflare Workers — zero dependencies. Compressed bytes are base64-encoded
 * so they fit in a TEXT column without schema changes.
 *
 * Messages shorter than MIN_COMPRESS_BYTES are stored raw because gzip
 * headers + base64 overhead would make them larger.
 */

const MIN_COMPRESS_BYTES = 128;

export const ENCODING_GZIP = "gzip+base64";

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const len = bytes.length;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Compress a string with gzip and return base64-encoded result.
 * Returns null if the input is too short to benefit from compression.
 */
export async function compressContent(
  text: string
): Promise<{ content: string; encoding: string | null }> {
  const raw = new TextEncoder().encode(text);

  if (raw.length < MIN_COMPRESS_BYTES) {
    return { content: text, encoding: null };
  }

  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  writer.write(raw);
  writer.close();

  const compressed = await new Response(cs.readable).arrayBuffer();
  const encoded = uint8ToBase64(new Uint8Array(compressed));

  // Only use compression if it actually saves space
  if (encoded.length >= text.length) {
    return { content: text, encoding: null };
  }

  return { content: encoded, encoding: ENCODING_GZIP };
}

/**
 * Decompress content based on its encoding.
 * If encoding is null/undefined, returns the content as-is (uncompressed).
 */
export async function decompressContent(
  content: string,
  encoding: string | null | undefined
): Promise<string> {
  if (!encoding) return content;

  if (encoding !== ENCODING_GZIP) {
    throw new Error(`Unknown content encoding: ${encoding}`);
  }

  const compressed = base64ToUint8(content);
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(compressed);
  writer.close();

  return new Response(ds.readable).text();
}
