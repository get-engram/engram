import { isExternalOAuthClient } from "./auth-kind.js";
import type { AuthContext } from "../types.js";

// Onboarding coaching for OAuth-connected apps (ChatGPT etc.). Hosted apps
// can't auto-capture, so new users have to learn the save-on-request
// patterns — otherwise they assume memory is automatic, discover it isn't,
// and churn. Tips surface in tool responses while the account is new and
// go silent once the user clearly has the hang of it.

const NEW_USER_MESSAGE_THRESHOLD = 20;

const CONTINUOUS_MEMORY_TIP =
  'Saved. Tip to pass on: the user can say "remember everything from this point forward" and you should keep saving the important turns automatically as the conversation develops. They can check what\'s stored anytime by asking "what do you remember about ___?".';

const SEARCH_EMPTY_TIP =
  'Nothing stored on this topic yet. The user can say "remember this" to save the current exchange, or "remember everything from this point forward" for continuous saving. Their full ChatGPT history can also be imported in one step at getengram.app/dashboard.';

/**
 * Coaching line for an empty search result — the highest-intent teaching
 * moment: the user asked for a memory that doesn't exist yet.
 */
export function searchEmptyTip(auth: AuthContext): string | undefined {
  return isExternalOAuthClient(auth) ? SEARCH_EMPTY_TIP : undefined;
}

/**
 * Coaching line on a successful append while the account is new (fewer
 * than NEW_USER_MESSAGE_THRESHOLD messages stored this month). Veterans
 * don't see it.
 */
export function newUserAppendTip(
  auth: AuthContext,
  usedThisMonth?: number,
): string | undefined {
  if (!isExternalOAuthClient(auth)) return undefined;
  if (typeof usedThisMonth !== "number") return undefined;
  if (usedThisMonth > NEW_USER_MESSAGE_THRESHOLD) return undefined;
  return CONTINUOUS_MEMORY_TIP;
}
