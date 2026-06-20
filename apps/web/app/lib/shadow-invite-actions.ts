/**
 * Shadow Chat Invites — pure UI action/state model for the web client (design Component A; Req 1, 3,
 * 6, 7, 10). Pure (no React) so the long-press/More menu, the request card, the routing sheet, and
 * the settings danger actions all render from ONE source of truth the tests assert against. Mirrors
 * the mobile `shadow-invite-actions` model so both clients behave identically.
 */

import type { RecipientRouting, ShadowInviteEvent } from '@chat-app/crypto';

/** The current resolved App-Lock mode, as the UI knows it. */
export type UiAppMode = 'real' | 'decoy' | null;

/** Whether the contact menu should offer "Shadow chat" — real mode only (Req 1.5, 10). */
export function showShadowChatLongPress(mode: UiAppMode): boolean {
  return mode === 'real';
}

/** A pending Accept/Decline request card rendered in the recipient's MAIN chat (Req 1.3). */
export interface ShadowInviteCard {
  inviteId: string;
  peerUid: string;
  label?: string;
}

/**
 * Fold a Shadow Chat Invites event into the current request-card set: add on `invite-received`,
 * remove on `invite-resolved` so the card auto-dismisses with no residue (Req 8, Property 13).
 */
export function reduceInviteCards(
  cards: ReadonlyMap<string, ShadowInviteCard>,
  event: ShadowInviteEvent,
): Map<string, ShadowInviteCard> {
  const next = new Map(cards);
  switch (event.type) {
    case 'invite-received':
      next.set(event.inviteId, {
        inviteId: event.inviteId,
        peerUid: event.peerUid,
        ...(event.label !== undefined ? { label: event.label } : {}),
      });
      return next;
    case 'invite-resolved':
      next.delete(event.inviteId);
      return next;
    default:
      return next;
  }
}

/** A routing choice offered on Accept (Req 3.1); `hidden` is the privacy-preserving default. */
export interface RoutingOption {
  value: RecipientRouting;
  label: string;
  description: string;
}

export const ROUTING_OPTIONS: readonly RoutingOption[] = [
  { value: 'hidden', label: 'Hidden shadow chat', description: 'Kept out of your main chat list and notifications.' },
  { value: 'merge', label: 'Show in main chat', description: 'Appears in your main chat list (view-only); the conversation stays isolated.' },
];

export const DEFAULT_RECIPIENT_ROUTING: RecipientRouting = 'hidden';

/** A destructive per-shadow-chat settings action (Req 6, 7), surfaced ONLY in real mode. */
export type ShadowDangerActionKey = 'clear-shadow' | 'revoke-shadow';

export interface ShadowDangerAction {
  key: ShadowDangerActionKey;
  label: string;
  description: string;
  destructive: boolean;
}

export const SHADOW_DANGER_ACTIONS: readonly ShadowDangerAction[] = [
  { key: 'clear-shadow', label: 'Clear shadow chat', description: 'Erase this chat’s history on this device. The chat keeps working.', destructive: false },
  { key: 'revoke-shadow', label: 'Revoke shadow chat', description: 'Delete the key and history on BOTH sides and close the chat. Cannot be undone.', destructive: true },
];

/** Real-mode-only Clear/Revoke actions; absent in decoy/locked (Req 6.6, 7.7, Properties 6, 16). */
export function shadowDangerActionsFor(mode: UiAppMode): readonly ShadowDangerAction[] {
  return mode === 'real' ? SHADOW_DANGER_ACTIONS : [];
}
