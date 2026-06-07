import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import { classifyReconnect, CLOSE_CODE_UNAUTHORIZED } from './realtime-client';

test('Property 13: close-code-driven reconnect classification', () => {
  // Feature: phase1-client-messaging, Property 13: Close-code-driven reconnect classification
  fc.assert(
    fc.property(
      // Cover the full WebSocket close-code range plus the specific Phase 1 codes.
      fc.oneof(
        fc.integer({ min: 1000, max: 4999 }),
        fc.constantFrom(4401, 4429, 4503, 1000, 1006),
      ),
      fc.boolean(),
      (closeCode, clientInitiated) => {
        const decision = classifyReconnect(closeCode, clientInitiated);

        if (clientInitiated) {
          // A deliberate disconnect never reconnects, regardless of code.
          assert.equal(decision, 'no-reconnect');
        } else if (closeCode === CLOSE_CODE_UNAUTHORIZED) {
          assert.equal(decision, 'refresh-reconnect');
        } else {
          // 4503/4429 and every other non-deliberate close fall through to backoff.
          assert.equal(decision, 'backoff-reconnect');
        }
      },
    ),
    { numRuns: 300 },
  );
});
