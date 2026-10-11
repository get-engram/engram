import { getPrivacySettings } from "@getengram/db";

/**
 * Effective privacy posture for an organization, resolved to booleans.
 * Both default to `true` (open) when the row/columns are missing, so the
 * feature never regresses existing behavior. See engram-web#19.
 */
export interface EffectivePrivacy {
  /** Assistants may see verbatim message/chunk content, not just metadata. */
  canReadBodies: boolean;
  /** Assistants may aggregate across conversations (list, global search). */
  canReadCrossConversation: boolean;
}

export async function loadPrivacy(
  db: D1Database,
  organizationId: string,
): Promise<EffectivePrivacy> {
  const row = await getPrivacySettings(db, organizationId).catch(() => null);
  return {
    // Treat only an explicit 0 as "off"; missing/undefined => open.
    canReadBodies: row?.assistant_can_read_bodies !== 0,
    canReadCrossConversation: row?.assistant_can_read_cross_conversation !== 0,
  };
}

export const PRIVACY_BODIES_NOTICE =
  "Message bodies are hidden by this account's privacy settings. Only metadata (titles, tags, roles, timestamps) is shared. The account owner can change this at getengram.app/dashboard.";

export const PRIVACY_CROSS_CONVERSATION_NOTICE =
  "Cross-conversation access is disabled by this account's privacy settings. Provide a specific conversation_id to read within a single conversation. The account owner can change this at getengram.app/dashboard.";

/**
 * Remove every body-DERIVED field from a search result row.
 *
 * `chunk_summary` is not metadata. summarizeChunk() returns the chunk
 * whitespace-normalised and truncated — for anything under the summary
 * budget that is the message text, character for character. The three
 * search paths each stripped only `chunk_text`, so with
 * "Share full message bodies" OFF a stored password came back verbatim in
 * `chunk_summary` (reproduced live 2026-10-11). The toggle's own copy
 * promises "only metadata — titles, tags, roles, and timestamps", and a
 * summary of the body is none of those.
 *
 * Every caller that returns search rows MUST route through this, so a new
 * body-derived column cannot leak by being forgotten in one of three places.
 */
export function stripBodyFields<T extends object>(
  rows: T[],
): Omit<T, "chunk_text" | "chunk_summary">[] {
  return rows.map((row) => {
    // Widened locally so the two fields can be peeled off whatever row shape
    // a caller has, without the generic demanding that they be declared.
    const {
      chunk_text: _text,
      chunk_summary: _summary,
      ...rest
    } = row as T & { chunk_text?: unknown; chunk_summary?: unknown };
    return rest as Omit<T, "chunk_text" | "chunk_summary">;
  });
}
