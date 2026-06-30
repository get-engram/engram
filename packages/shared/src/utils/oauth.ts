import { nanoid } from "nanoid";

// Opaque OAuth credential generators. Prefixes mirror the `engram_sk_live_`
// API-key convention so the auth middleware can route by prefix.

/** Access token presented as a Bearer on /mcp and /api/* (~1 h lifetime). */
export function generateAccessToken(): string {
  return `engram_at_${nanoid(32)}`;
}

/** Refresh token exchanged at /oauth/token for a new access token (~60 d). */
export function generateRefreshToken(): string {
  return `engram_rt_${nanoid(32)}`;
}

/** Single-use authorization code returned from /oauth/authorize. */
export function generateAuthorizationCode(): string {
  return `engram_ac_${nanoid(32)}`;
}

/** Public client identifier issued by Dynamic Client Registration. */
export function generateClientId(): string {
  return `client_${nanoid(24)}`;
}

/** Optional client secret for confidential clients. */
export function generateClientSecret(): string {
  return `engram_cs_${nanoid(40)}`;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** BASE64URL(SHA-256(input)) — the S256 transform used by PKCE (RFC 7636). */
export async function sha256Base64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

/**
 * Verify a PKCE code_verifier against a stored code_challenge.
 * Only the S256 method is supported (plain is disallowed by OAuth 2.1).
 * Comparison is length-then-constant-time to avoid leaking via timing.
 */
export async function verifyPkceS256(
  codeVerifier: string,
  codeChallenge: string,
): Promise<boolean> {
  const computed = await sha256Base64Url(codeVerifier);
  if (computed.length !== codeChallenge.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ codeChallenge.charCodeAt(i);
  }
  return diff === 0;
}
