/**
 * Conversation action model (P3 header declutter — design Component 7, Requirements 3.1, 3.3, 3.4).
 *
 * The redesigned conversation header keeps only `back · avatar · name · status · overflow`. The four
 * actions that used to be crammed into the header as emoji icons — disappearing messages, verify
 * identity, safety number, hide chat — move into a single overflow (`⋮`) menu AND the new
 * Contact/Profile screen. Both surfaces render from the SAME ordered list below, so an action can
 * never be reachable in one place but missing from the other.
 *
 * This module is intentionally pure (no React, no React Native) so it is the single source of truth
 * that both screens consume and that the example tests assert against.
 */

/** Stable identity of each action moved off the header. */
export type ConversationActionKey = 'disappearing' | 'verify' | 'safety' | 'hide';

export interface ConversationAction {
  /** Stable key wired to the existing conversation callback. */
  key: ConversationActionKey;
  /** Human label shown in the overflow menu and the profile row. */
  label: string;
}

/**
 * The four actions, in display order, surfaced by BOTH the overflow menu (Req 3.3) and the
 * Contact/Profile screen (Req 3.4). Each maps 1:1 to an existing conversation callback:
 *   - `disappearing` → onSetTimer
 *   - `verify`       → onRequestVerification / onRespondVerification
 *   - `safety`       → getSafetyNumber
 *   - `hide`         → onHideChat / onUnhideChat
 */
export const CONVERSATION_ACTIONS: readonly ConversationAction[] = [
  { key: 'disappearing', label: 'Disappearing messages' },
  { key: 'verify', label: 'Verify identity' },
  { key: 'safety', label: 'Safety number' },
  { key: 'hide', label: 'Hide chat' },
];

/** The set of action keys, for membership/reachability checks. */
export function conversationActionKeys(): ConversationActionKey[] {
  return CONVERSATION_ACTIONS.map((a) => a.key);
}

/** The elements of the redesigned conversation header, left → right (Req 3.1). */
export type HeaderElement = 'back' | 'avatar' | 'name' | 'status' | 'overflow';

export const CONVERSATION_HEADER_ELEMENTS: readonly HeaderElement[] = [
  'back',
  'avatar',
  'name',
  'status',
  'overflow',
];
