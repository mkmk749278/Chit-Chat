import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import {
  canSendComposerText,
  COMPOSER_MAX_LENGTH,
  initialConversationState,
  reduce,
  type ConversationEvent,
  type RenderableMessage,
} from './conversation-reducer';

const messageArb: fc.Arbitrary<RenderableMessage> = fc.record({
  id: fc.string(),
  seq: fc.nat({ max: 50 }),
  direction: fc.constantFrom<'in' | 'out'>('in', 'out'),
  text: fc.option(fc.string(), { nil: null }),
  status: fc.constantFrom('sending', 'sent', 'failed', 'received', 'delivery-error'),
});

test('Property 6: message-list dedup and ordering', () => {
  // Feature: phase1-client-messaging, Property 6: Message-list dedup and ordering
  fc.assert(
    fc.property(fc.array(messageArb, { maxLength: 200 }), (messages) => {
      // Feed each message-appended event, possibly duplicated, in arbitrary order.
      const events: ConversationEvent[] = messages.map((message) => ({
        type: 'message-appended',
        message,
      }));
      const state = events.reduce(reduce, initialConversationState('mobile'));

      // 1. Each (direction, seq) appears exactly once.
      const keys = state.messages.map((m) => `${m.direction}:${m.seq}`);
      assert.equal(new Set(keys).size, keys.length, 'no duplicate (direction, seq)');

      // 2. The list is ordered ascending by seq.
      for (let i = 1; i < state.messages.length; i += 1) {
        assert.ok(state.messages[i]!.seq >= state.messages[i - 1]!.seq, 'ascending by seq');
      }

      // 3. The set of rendered keys equals the set of input keys (nothing lost/added).
      const inputKeys = new Set(messages.map((m) => `${m.direction}:${m.seq}`));
      assert.deepEqual(new Set(keys), inputKeys);
    }),
    { numRuns: 200 },
  );
});

test('Property 21: composer send-enablement validation', () => {
  // Feature: phase1-client-messaging, Property 21: Composer send-enablement validation
  fc.assert(
    fc.property(fc.string({ maxLength: COMPOSER_MAX_LENGTH + 50 }), (text) => {
      const trimmedLength = text.trim().length;
      const expected = trimmedLength >= 1 && trimmedLength <= COMPOSER_MAX_LENGTH;
      assert.equal(canSendComposerText(text), expected);
    }),
    { numRuns: 300 },
  );
});

test('Property 21: whitespace-only input never enables sending', () => {
  // Feature: phase1-client-messaging, Property 21: Composer send-enablement validation
  fc.assert(
    fc.property(
      fc.stringOf(fc.constantFrom(' ', '\t', '\n', '\r'), { maxLength: 50 }),
      (whitespace) => {
        assert.equal(canSendComposerText(whitespace), false);
      },
    ),
    { numRuns: 100 },
  );
});
