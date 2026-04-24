import { describe, it, expect } from "vitest";
import { verifySupabaseJwt } from "../utils/jwt.js";

const SECRET = "super-secret-jwt-token-with-at-least-32-chars";

/** Build a HS256 JWT using Web Crypto (same approach the utility uses). */
async function signJwt(
  payload: Record<string, unknown>,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();

  function base64Url(buf: ArrayBuffer | Uint8Array): string {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  const header = base64Url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = base64Url(encoder.encode(JSON.stringify(payload)));
  const data = encoder.encode(`${header}.${body}`);

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, data);

  return `${header}.${body}.${base64Url(sig)}`;
}

describe("verifySupabaseJwt", () => {
  it("verifies a valid token and returns claims", async () => {
    const token = await signJwt(
      {
        sub: "user-123",
        email: "alice@example.com",
        role: "authenticated",
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      SECRET,
    );

    const claims = await verifySupabaseJwt(token, SECRET);
    expect(claims.sub).toBe("user-123");
    expect(claims.email).toBe("alice@example.com");
    expect(claims.role).toBe("authenticated");
  });

  it("rejects a token signed with the wrong secret", async () => {
    const token = await signJwt(
      {
        sub: "user-123",
        email: "alice@example.com",
        role: "authenticated",
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      "wrong-secret-that-is-definitely-not-correct",
    );

    await expect(verifySupabaseJwt(token, SECRET)).rejects.toThrow(
      "Invalid JWT signature",
    );
  });

  it("rejects an expired token", async () => {
    const token = await signJwt(
      {
        sub: "user-123",
        email: "alice@example.com",
        role: "authenticated",
        exp: Math.floor(Date.now() / 1000) - 60, // expired 1 min ago
      },
      SECRET,
    );

    await expect(verifySupabaseJwt(token, SECRET)).rejects.toThrow(
      "JWT has expired",
    );
  });

  it("rejects a token with wrong role", async () => {
    const token = await signJwt(
      {
        sub: "user-123",
        email: "alice@example.com",
        role: "anon",
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      SECRET,
    );

    await expect(verifySupabaseJwt(token, SECRET)).rejects.toThrow(
      "JWT role is not 'authenticated'",
    );
  });

  it("rejects malformed tokens", async () => {
    await expect(verifySupabaseJwt("not-a-jwt", SECRET)).rejects.toThrow();
    await expect(verifySupabaseJwt("a.b", SECRET)).rejects.toThrow("expected 3 parts");
    await expect(verifySupabaseJwt("", SECRET)).rejects.toThrow();
  });
});
