import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BackoffPolicy,
  DEFAULT_BASE_MS,
  DEFAULT_CAP_MS,
  REGISTRATION_BUDGET_MS,
} from './backoff-policy';

// Feature: phase1-client-messaging, Property 11: Backoff delays stay within bounds.
// Example-based coverage of the [base, cap] invariant across many attempts and RNG extremes.

test('delay stays within [base, cap] for all attempts and RNG extremes (Property 11)', () => {
  for (const rngValue of [0, 0.5, 0.999999, 1, -1, Number.NaN]) {
    const policy = new BackoffPolicy({ rng: () => rngValue });
    for (let attempt = 0; attempt <= 40; attempt += 1) {
      const delay = policy.delayForAttempt(attempt);
      assert.ok(
        delay >= DEFAULT_BASE_MS && delay <= DEFAULT_CAP_MS,
        `attempt ${attempt} rng ${rngValue} → ${delay} out of [${DEFAULT_BASE_MS}, ${DEFAULT_CAP_MS}]`,
      );
    }
  }
});

test('rng=0 yields exactly the base (lower jitter edge)', () => {
  const policy = new BackoffPolicy({ rng: () => 0 });
  assert.equal(policy.delayForAttempt(0), DEFAULT_BASE_MS);
  assert.equal(policy.delayForAttempt(10), DEFAULT_BASE_MS);
});

test('rng→1 approaches the exponential target, saturating at the cap', () => {
  const policy = new BackoffPolicy({ rng: () => 0.999999 });
  // attempt 0 target == base, so the delay is ~base.
  assert.ok(Math.abs(policy.delayForAttempt(0) - DEFAULT_BASE_MS) < 1);
  // attempt 2 target == base*4 == 2000ms.
  assert.ok(policy.delayForAttempt(2) > DEFAULT_BASE_MS);
  // large attempts saturate at the cap.
  assert.ok(policy.delayForAttempt(30) <= DEFAULT_CAP_MS);
  assert.ok(policy.delayForAttempt(30) > DEFAULT_CAP_MS - 1);
});

test('exponential target doubles per attempt until the cap (rng=1 upper edge)', () => {
  const policy = new BackoffPolicy({ rng: () => 0.999999, capMs: 1_000_000 });
  const d0 = policy.delayForAttempt(0);
  const d1 = policy.delayForAttempt(1);
  const d2 = policy.delayForAttempt(2);
  // base=500 → ~500, ~1000, ~2000 (within rounding of the jitter edge).
  assert.ok(d1 > d0 && d2 > d1);
});

test('registration budget reports exhausted at or beyond the budget (3.6, 3.9)', () => {
  const policy = new BackoffPolicy();
  assert.equal(policy.isRegistrationBudgetExhausted(0), false);
  assert.equal(policy.isRegistrationBudgetExhausted(REGISTRATION_BUDGET_MS - 1), false);
  assert.equal(policy.isRegistrationBudgetExhausted(REGISTRATION_BUDGET_MS), true);
  assert.equal(policy.isRegistrationBudgetExhausted(REGISTRATION_BUDGET_MS + 1), true);
});

test('nextRegistrationDelay returns a bounded delay until budget, then null', () => {
  const policy = new BackoffPolicy({ rng: () => 0.5 });
  const delay = policy.nextRegistrationDelay(0, 0);
  assert.ok(delay !== null && delay >= DEFAULT_BASE_MS && delay <= DEFAULT_CAP_MS);
  assert.equal(policy.nextRegistrationDelay(0, REGISTRATION_BUDGET_MS), null);
});

test('constructor rejects invalid bounds', () => {
  assert.throws(() => new BackoffPolicy({ baseMs: 0 }), TypeError);
  assert.throws(() => new BackoffPolicy({ baseMs: 1000, capMs: 500 }), TypeError);
  assert.throws(() => new BackoffPolicy({ budgetMs: -1 }), TypeError);
  // @ts-expect-error exercising the runtime guard
  assert.throws(() => new BackoffPolicy({ rng: 5 }), TypeError);
});

test('delayForAttempt rejects a non-integer or negative attempt', () => {
  const policy = new BackoffPolicy();
  assert.throws(() => policy.delayForAttempt(-1), TypeError);
  assert.throws(() => policy.delayForAttempt(1.5), TypeError);
});
