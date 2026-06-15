import assert from 'node:assert/strict';
import { test } from 'node:test';

import { initialConversationState, reduce } from './conversation-reducer';

/** Tests for the disappearing-timer state in the reducer (Phase 2, Req 4.1). */

test('initial disappearing timer is 0 (disabled)', () => {
  assert.equal(initialConversationState('mobile').disappearingTtlMs, 0);
});

test('timer-changed sets the conversation TTL', () => {
  const s = reduce(initialConversationState('mobile'), { type: 'timer-changed', ttlMs: 86_400_000 });
  assert.equal(s.disappearingTtlMs, 86_400_000);
});

test('timer-changed with 0 disables the timer', () => {
  let s = reduce(initialConversationState('mobile'), { type: 'timer-changed', ttlMs: 5000 });
  s = reduce(s, { type: 'timer-changed', ttlMs: 0 });
  assert.equal(s.disappearingTtlMs, 0);
});

test('a negative ttl is clamped to 0', () => {
  const s = reduce(initialConversationState('mobile'), { type: 'timer-changed', ttlMs: -10 });
  assert.equal(s.disappearingTtlMs, 0);
});

test('timer-changed does not disturb messages or composer', () => {
  let s = reduce(initialConversationState('mobile'), {
    type: 'message-appended',
    message: { id: 'm1', seq: 1, direction: 'in', text: 'hi', status: 'received' },
  });
  s = reduce(s, { type: 'composer-changed', text: 'draft' });
  s = reduce(s, { type: 'timer-changed', ttlMs: 1000 });
  assert.equal(s.messages.length, 1);
  assert.equal(s.composer.text, 'draft');
  assert.equal(s.disappearingTtlMs, 1000);
});
