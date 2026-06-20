/**
 * Shadow Chat Invites — pure UI action/state model (Shadow Chat Invites, design Component A; Req 1, 3,
 * 6, 7, 10). Like {@link CONVERSATION_ACTIONS}, this module is intentionally pure (no React / React
 * Native) so the long-press menu, the request card, the routing sheet, and the settings danger
 * actions all render from ONE source of truth the tests assert against. The screens map each entry to
 * the matching `ChatController` method (`createShadowInvite` / `acceptShadowInvite` /
 * `declineShadowInvite` / `revokeShadowChat` / `clearShadowChat`).
 */

import type { RecipientRouting, ShadowInviteEvent } from '@chat-app/crypto';

/** The current resolved App-Lock mode, as the UI knows it. */
export type UiAppMode = 'real' | 'decoy' | null;

/**
 * Whether the contact long-press menu should offer "Shadow chat" (→ `createShadowInvite`). Real mode
 * only: in decoy/locked the option is OMITTED entirely so coercion reveals nothing (Req 1.5, 10).
 */
export function showShadowChatLongPress(mode: UiAppMode): boolean {
  return mode === 'real';
}

/** A pending Accept/Decline request card rendered in the recipient's MAIN chat (Req 1.3). */
export interface ShadowInviteCard {
  inviteId: string;
  peerUid: string;
  /** Optional human-readable thread name shown on the card; blank by default for deniability. */
  label?: string;
}

/**
 * Fold a Shadow Chat Invites event into the current set of visible request cards. `invite-received`
 * adds a card; `invite-resolved` (accepted/declined/expired) and `thread-revoked` remove it so the
 * card auto-dismisses with no residue (Req 8, Correctness Property 13). Pure and order-independent:
 * the UI keeps a `Map<inviteId, ShadowInviteCard>` and applies this reducer to each event.
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
    case 'thread-revoked':
      // A revoke can arrive for a thread whose card was already resolved; dropping by peer is a safe
      // no-op here (cards are keyed by inviteId), so nothing to remove — kept for exhaustiveness.
      return next;
    default:
      // invite-sent / invite-accepted / invite-declined do not change the recipient's card set.
      return next;
  }
}

/** A routing choice offered on Accept (Req 3.1): `hidden` is the privacy-preserving default. */
export interface RoutingOption {
  value: RecipientRouting;
  label: string;
  description: string;
}

/** The routing-choice sheet options, in display order with `hidden` first (the default). */
export const ROUTING_OPTIONS: readonly RoutingOption[] = [
  {
    value: 'hidden',
    label: 'Hidden shadow chat',
    description: 'Kept out of your main chat list and notifications.',
  },
  {
    value: 'merge',
    label: 'Show in main chat',
    description: 'Appears in your main chat list (view-only); the conversation stays isolated.',
  },
];

/** The default routing applied when the recipient does not explicitly choose (Req 3.1). */
export const DEFAULT_RECIPIENT_ROUTING: RecipientRouting = 'hidden';

/** A destructive per-shadow-chat settings action (Req 6, 7). Surfaced ONLY in real mode. */
export type ShadowDangerActionKey = 'clear-shadow' | 'revoke-shadow';

export interface ShadowDangerAction {
  key: ShadowDangerActionKey;
  label: string;
  description: string;
  /** Whether the action needs a confirm step (revoke is irreversible + two-sided). */
  destructive: boolean;
}

/** "Clear shadow chat" (local, keep key) and "Revoke shadow chat" (delete key + both sides). */
export const SHADOW_DANGER_ACTIONS: readonly ShadowDangerAction[] = [
  {
    key: 'clear-shadow',
    label: 'Clear shadow chat',
    description: 'Erase this chat’s history on this device. The chat keeps working.',
    destructive: false,
  },
  {
    key: 'revoke-shadow',
    label: 'Revoke shadow chat',
    description: 'Delete the key and history on BOTH sides and close the chat. Cannot be undone.',
    destructive: true,
  },
];

/**
 * The shadow danger actions the settings screen should render for a shadow chat. Real mode only — in
 * decoy/locked the actions are absent and act on nothing (Req 6.6, 7.7, Correctness Properties 6, 16).
 */
export function shadowDangerActionsFor(mode: UiAppMode): readonly ShadowDangerAction[] {
  return mode === 'real' ? SHADOW_DANGER_ACTIONS : [];
}
