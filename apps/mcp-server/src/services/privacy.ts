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
