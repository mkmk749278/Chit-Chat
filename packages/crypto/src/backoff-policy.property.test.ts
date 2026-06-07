import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import { BackoffPolicy, DEFAULT_BASE_MS, DEFAULT_CAP_MS } from './backoff-policy';

test('Property 11: backoff delays stay within bounds', () => {
  // Feature: phase1-client-messaging, Property 11: Backoff delays stay within bounds
  fc.assert(
    fc.property(
      fc.nat({ max: 100 }),
      // RNG output is [0, 1); include the extremes the policy must clamp safely.
      fc.double({ min: 0, max: 0.999999, noNaN: true }),
      (attempt, rngValue) => {
        const policy = new BackoffPolicy({ rng: () => rngValue });
        const delay = policy.delayForAttempt(attempt);
        assert.ok(
          delay >= DEFAULT_BASE_MS && delay <= DEFAULT_CAP_MS,
          `attempt=${attempt} rng=${rngValue} → ${delay} outside [${DEFAULT_BASE_MS}, ${DEFAULT_CAP_MS}]`,
        );
      },
    ),
    { numRuns: 300 },
  );
});

test('Property 11: custom base/cap bounds are also honoured', () => {
  // Feature: phase1-client-messaging, Property 11: Backoff delays stay within bounds
  fc.assert(
    fc.property(
      fc.nat({ max: 100 }),
      fc.double({ min: 0, max: 0.999999, noNaN: true }),
      fc.integer({ min: 1, max: 1000 }),
      fc.integer({ min: 1000, max: 120_000 }),
      (attempt, rngValue, baseMs, capMs) => {
        const policy = new BackoffPolicy({ rng: () => rngValue, baseMs, capMs });
        const delay = policy.delayForAttempt(attempt);
        assert.ok(delay >= baseMs && delay <= capMs);
      },
    ),
    { numRuns: 200 },
  );
});
