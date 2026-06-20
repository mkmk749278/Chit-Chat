/**
 * Tests for the pure Shadow Chat Invites UI action/state model (design Component A; Req 1, 3, 6, 7,
 * 10). Asserts long-press gating, request-card reduction (add on received, drop on resolved), the
 * routing options + default, and the real-mode-only settings danger actions.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ShadowInviteEvent } from '@chat-app/crypto';

import {
  DEFAULT_RECIPIENT_ROUTING,
  ROUTING_OPTIONS,
  reduceInviteCards,
  shadowDangerActionsFor,
  showShadowChatLongPress,
  type ShadowInviteCard,
} from './shadow-invite-actions';

test('the "Shadow chat" long-press option appears ONLY in real mode', () => {
  assert.equal(showShadowChatLongPress('real'), true);
  assert.equal(showShadowChatLongPress('decoy'), false);
  assert.equal(showShadowChatLongPress(null), false);
});

test('invite-received adds a request card; invite-resolved removes it (auto-dismiss, no residue)', () => {
  let cards: ReadonlyMap<string, ShadowInviteCard> = new Map();
  cards = reduceInviteCards(cards, {
    type: 'invite-received',
    inviteId: 'inv-1',
    peerUid: 'bob',
    label: 'Project X',
  });
  assert.equal(cards.size, 1);
  assert.deepEqual(cards.get('inv-1'), { inviteId: 'inv-1', peerUid: 'bob', label: 'Project X' });

  cards = reduceInviteCards(cards, { type: 'invite-resolved', inviteId: 'inv-1', reason: 'accepted' });
  assert.equal(cards.size, 0, 'the card is removed once the invite resolves');
});

test('a received card without a label omits the label field (deniability default)', () => {
  const cards = reduceInviteCards(new Map(), {
    type: 'invite-received',
    inviteId: 'inv-2',
    peerUid: 'carol',
  });
  assert.deepEqual(cards.get('inv-2'), { inviteId: 'inv-2', peerUid: 'carol' });
});

test('unrelated lifecycle events leave the recipient card set unchanged', () => {
  const start = reduceInviteCards(new Map(), { type: 'invite-received', inviteId: 'inv-3', peerUid: 'dave' });
  const events: ShadowInviteEvent[] = [
    { type: 'invite-sent', inviteId: 'x', peerUid: 'p', threadId: 't' },
    { type: 'invite-accepted', inviteId: 'x', peerUid: 'p', threadId: 't' },
    { type: 'invite-declined', inviteId: 'x', peerUid: 'p' },
    { type: 'thread-revoked', threadId: 't', peerUid: 'p', initiatedBy: 'peer' },
  ];
  let cards: ReadonlyMap<string, ShadowInviteCard> = start;
  for (const e of events) cards = reduceInviteCards(cards, e);
  assert.deepEqual([...cards.keys()], ['inv-3']);
});

test('routing options lead with hidden (the default) and offer merge', () => {
  assert.equal(DEFAULT_RECIPIENT_ROUTING, 'hidden');
  assert.deepEqual(
    ROUTING_OPTIONS.map((o) => o.value),
    ['hidden', 'merge'],
  );
});

test('settings danger actions are real-mode only and offer clear + revoke', () => {
  assert.deepEqual(
    shadowDangerActionsFor('real').map((a) => a.key),
    ['clear-shadow', 'revoke-shadow'],
  );
  assert.equal(shadowDangerActionsFor('decoy').length, 0);
  assert.equal(shadowDangerActionsFor(null).length, 0);
  // Revoke is flagged destructive (irreversible, two-sided); clear is not.
  const revoke = shadowDangerActionsFor('real').find((a) => a.key === 'revoke-shadow');
  assert.equal(revoke?.destructive, true);
});
