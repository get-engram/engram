import type { AuthContext } from "../types.js";

/**
 * Shared vs private memory spaces (engram#264).
 *
 * Model: every conversation is 'shared' (org-wide — the default and the
 * pre-#264 behavior) or 'private' to the seat that created it. Owner
 * keys and OAuth connections have no seat (seatId null); their private
 * conversations carry seat_id NULL, so "same identity" means seat ids
 * match including the null case. Org data export remains org-wide (the
 * account owner's GDPR surface).
 */

export interface ConversationVisibilityRow {
  visibility?: string | null;
  seat_id?: string | null;
}

export function canAccessConversation(
  auth: AuthContext,
  conv: ConversationVisibilityRow,
): boolean {
  if (auth.isAdmin) return true;
  if ((conv.visibility ?? "shared") !== "private") return true;
  return (conv.seat_id ?? null) === (auth.seatId ?? null);
}

/** Normalize + validate a requested visibility value. */
export function parseVisibility(
  value: unknown,
): "shared" | "private" | undefined {
  if (value === "shared" || value === "private") return value;
  return undefined;
}
