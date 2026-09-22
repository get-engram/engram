import { isExternalOAuthClient } from "./auth-kind.js";
import { getStorageUsed } from "@getengram/db";
import type { Env, AuthContext } from "../types.js";

// Account-state notes attached to tool responses for OAuth-connected apps.
//
// Directory policy (both Anthropic's and OpenAI's reviewers, Sept 2026):
// imperatives aimed at the model are prohibited in tool descriptions,
// server instructions AND tool outputs — "moving such an instruction into a
// tool output does not resolve it." The previous versions of these strings
// scripted the model ("call append_messages RIGHT NOW — do not ask
// permission", scripted reply lines, dashboard/import upsell URLs) and were
// cited in both stores' rejections. Everything here must stay FACTUAL:
// state the account's condition, never direct the model's next action, never
// carry marketing. Activation now lives on our own product surfaces (the
// post-connect web demo, the dashboard, lifecycle email) — not in injected
// context.

const NEW_USER_MESSAGE_THRESHOLD = 20;

const CONTINUOUS_MEMORY_NOTE =
  "Saved. This account supports ongoing saves within a conversation when the user has asked for that (for example, a standing request to remember things going forward).";

const SEARCH_EMPTY_NOTE =
  "No stored content matches this query. Content is saved when the user asks to remember something.";

/**
 * Factual note for an empty search result on a connector account.
 */
export function searchEmptyTip(auth: AuthContext): string | undefined {
  return isExternalOAuthClient(auth) ? SEARCH_EMPTY_NOTE : undefined;
}

const FIRST_RUN_NOTE =
  "Account state: nothing has been saved to this account yet beyond the auto-generated welcome note.";

const FIRST_SAVE_NOTE =
  "Account state: this was the first memory saved to this account. Saved content is retrievable with `search`, including from the user's other connected apps.";

/**
 * Sync variant for callers that already know the stored-message count
 * (memory_status fetches it anyway — no second query needed).
 */
export function firstRunActivationForCount(
  auth: AuthContext,
  storedTotal: number,
): string | undefined {
  if (!isExternalOAuthClient(auth)) return undefined;
  return storedTotal <= 1 ? FIRST_RUN_NOTE : undefined;
}

/**
 * Factual empty-account note attached to read-tool results while the account
 * has nothing stored beyond the auto-seeded welcome note. One indexed D1
 * point-read, OAuth connectors only; undefined otherwise.
 */
export async function firstRunActivation(
  env: Env,
  auth: AuthContext,
): Promise<string | undefined> {
  if (!isExternalOAuthClient(auth)) return undefined;
  try {
    const row = await getStorageUsed(env.DB, auth.organizationId);
    const used = (row as { messages_stored_total?: number } | null)?.messages_stored_total ?? 0;
    return firstRunActivationForCount(auth, used);
  } catch {
    return undefined; // a state note must never break a tool call
  }
}

/**
 * Factual note on the account's first real save (storage was <= the welcome
 * note before this append).
 */
export function firstSaveCelebration(
  auth: AuthContext,
  usedBeforeAppend: number | undefined,
): string | undefined {
  if (!isExternalOAuthClient(auth)) return undefined;
  if (typeof usedBeforeAppend !== "number" || usedBeforeAppend > 1) return undefined;
  return FIRST_SAVE_NOTE;
}

/**
 * Note on a successful append while the account is new (fewer than
 * NEW_USER_MESSAGE_THRESHOLD messages stored this month). Veterans don't
 * see it.
 */
export function newUserAppendTip(
  auth: AuthContext,
  usedThisMonth?: number,
): string | undefined {
  if (!isExternalOAuthClient(auth)) return undefined;
  if (typeof usedThisMonth !== "number") return undefined;
  if (usedThisMonth > NEW_USER_MESSAGE_THRESHOLD) return undefined;
  return CONTINUOUS_MEMORY_NOTE;
}
