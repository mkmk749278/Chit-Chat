import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import {
  initialConversationState,
  reduce,
  type ConversationEvent,
} from './conversation-reducer';

/**
 * "Messaging enabled" is the predicate both platform Conversation_Screens apply:
 * the composer is sendable AND (on web) the ephemerality warning is acknowledged.
 */
const messagingEnabled = (s: ReturnType<typeof initialConversationState>): boolean =>
  s.composer.canSend && s.webWarningAcknowledged;

test('Property 18: web messaging is gated until the ephemerality warning is acknowledged', () => {
  // Feature: phase1-client-messaging, Property 18: Web messaging gated on ephemerality acknowledgment
  fc.assert(
    fc.property(
      // A stream of composer edits (some valid, some whitespace/empty), then ack, then more edits.
      fc.array(fc.string({ maxLength: 20 }), { maxLength: 20 }),
      fc.array(fc.string({ maxLength: 20 }), { maxLength: 20 }),
      (beforeAck, afterAck) => {
        let state = initialConversationState('web');
        assert.equal(state.webWarningAcknowledged, false);

        // Before acknowledgment: messaging is disabled no matter what is typed.
        for (const text of beforeAck) {
          state = reduce(state, { type: 'composer-changed', text });
          assert.equal(messagingEnabled(state), false, 'gated before acknowledgment');
        }

        // Acknowledge once.
        state = reduce(state, { type: 'web-warning-acknowledged' });
        assert.equal(state.webWarningAcknowledged, true);

        // After acknowledgment: enablement tracks composer validity exactly.
        for (const text of afterAck) {
          state = reduce(state, { type: 'composer-changed', text });
          assert.equal(messagingEnabled(state), state.composer.canSend);
        }
      },
    ),
    { numRuns: 200 },
  );
});

test('Property 18: mobile is never gated (starts acknowledged)', () => {
  // Feature: phase1-client-messaging, Property 18: Web messaging gated on ephemerality acknowledgment
  fc.assert(
    fc.property(fc.array(fc.string({ maxLength: 20 }), { maxLength: 30 }), (edits) => {
      let state = initialConversationState('mobile');
      assert.equal(state.webWarningAcknowledged, true);
      for (const text of edits) {
        const event: ConversationEvent = { type: 'composer-changed', text };
        state = reduce(state, event);
        assert.equal(messagingEnabled(state), state.composer.canSend);
      }
    }),
    { numRuns: 100 },
  );
});
