import { describe, it, expect } from "vitest";
import { canAccessConversation, parseVisibility } from "../services/spaces.js";
import type { AuthContext } from "../types.js";

const seatAuth = (seatId: string | null): AuthContext => ({
  organizationId: "org_1",
  apiKeyId: "key_1",
  tier: "team",
  scopes: ["read", "write", "search", "delete"],
  seatId,
});

describe("canAccessConversation (engram#264)", () => {
  it("shared conversations are visible to everyone", () => {
    expect(canAccessConversation(seatAuth("seat_a"), { visibility: "shared", seat_id: "seat_b" })).toBe(true);
    expect(canAccessConversation(seatAuth(null), { visibility: "shared", seat_id: "seat_b" })).toBe(true);
  });

  it("legacy rows without visibility behave as shared", () => {
    expect(canAccessConversation(seatAuth("seat_a"), {})).toBe(true);
    expect(canAccessConversation(seatAuth("seat_a"), { visibility: null })).toBe(true);
  });

  it("private conversations are only visible to their seat", () => {
    expect(canAccessConversation(seatAuth("seat_a"), { visibility: "private", seat_id: "seat_a" })).toBe(true);
    expect(canAccessConversation(seatAuth("seat_b"), { visibility: "private", seat_id: "seat_a" })).toBe(false);
    expect(canAccessConversation(seatAuth(null), { visibility: "private", seat_id: "seat_a" })).toBe(false);
  });

  it("owner-key private conversations (seat null) are private to owner keys", () => {
    expect(canAccessConversation(seatAuth(null), { visibility: "private", seat_id: null })).toBe(true);
    expect(canAccessConversation(seatAuth("seat_a"), { visibility: "private", seat_id: null })).toBe(false);
  });

  it("admin bypasses", () => {
    const admin = { ...seatAuth(null), isAdmin: true };
    expect(canAccessConversation(admin, { visibility: "private", seat_id: "seat_a" })).toBe(true);
  });
});

describe("parseVisibility", () => {
  it("accepts only valid values", () => {
    expect(parseVisibility("shared")).toBe("shared");
    expect(parseVisibility("private")).toBe("private");
    expect(parseVisibility("public")).toBeUndefined();
    expect(parseVisibility(undefined)).toBeUndefined();
  });
});
