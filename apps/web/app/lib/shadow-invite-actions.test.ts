import { describe, expect, it } from 'vitest';

import type { ShadowInviteEvent } from '@chat-app/crypto';

import {
  DEFAULT_RECIPIENT_ROUTING,
  ROUTING_OPTIONS,
  reduceInviteCards,
  shadowDangerActionsFor,
  showShadowChatLongPress,
  type ShadowInviteCard,
} from './shadow-invite-actions';

describe('shadow-invite-actions (web UI model)', () => {
  it('offers the "Shadow chat" option only in real mode', () => {
    expect(showShadowChatLongPress('real')).toBe(true);
    expect(showShadowChatLongPress('decoy')).toBe(false);
    expect(showShadowChatLongPress(null)).toBe(false);
  });

  it('adds a request card on invite-received and removes it on invite-resolved', () => {
    let cards: ReadonlyMap<string, ShadowInviteCard> = new Map();
    cards = reduceInviteCards(cards, { type: 'invite-received', inviteId: 'inv-1', peerUid: 'bob', label: 'X' });
    expect(cards.get('inv-1')).toEqual({ inviteId: 'inv-1', peerUid: 'bob', label: 'X' });
    cards = reduceInviteCards(cards, { type: 'invite-resolved', inviteId: 'inv-1', reason: 'declined' });
    expect(cards.size).toBe(0);
  });

  it('omits the label when none is supplied (deniability default)', () => {
    const cards = reduceInviteCards(new Map(), { type: 'invite-received', inviteId: 'i', peerUid: 'p' });
    expect(cards.get('i')).toEqual({ inviteId: 'i', peerUid: 'p' });
  });

  it('leaves cards unchanged for non-recipient lifecycle events', () => {
    const events: ShadowInviteEvent[] = [
      { type: 'invite-sent', inviteId: 'x', peerUid: 'p', threadId: 't' },
      { type: 'invite-accepted', inviteId: 'x', peerUid: 'p', threadId: 't' },
      { type: 'thread-revoked', threadId: 't', peerUid: 'p', initiatedBy: 'self' },
    ];
    let cards: ReadonlyMap<string, ShadowInviteCard> = reduceInviteCards(new Map(), {
      type: 'invite-received',
      inviteId: 'keep',
      peerUid: 'p',
    });
    for (const e of events) cards = reduceInviteCards(cards, e);
    expect([...cards.keys()]).toEqual(['keep']);
  });

  it('leads routing with hidden (default) and offers merge', () => {
    expect(DEFAULT_RECIPIENT_ROUTING).toBe('hidden');
    expect(ROUTING_OPTIONS.map((o) => o.value)).toEqual(['hidden', 'merge']);
  });

  it('exposes Clear/Revoke danger actions only in real mode, with revoke marked destructive', () => {
    expect(shadowDangerActionsFor('real').map((a) => a.key)).toEqual(['clear-shadow', 'revoke-shadow']);
    expect(shadowDangerActionsFor('decoy')).toHaveLength(0);
    expect(shadowDangerActionsFor(null)).toHaveLength(0);
    expect(shadowDangerActionsFor('real').find((a) => a.key === 'revoke-shadow')?.destructive).toBe(true);
  });
});
