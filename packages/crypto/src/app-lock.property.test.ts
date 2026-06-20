import assert from 'node:assert/strict';
import { pbkdf2 } from 'node:crypto';
import { test } from 'node:test';

import fc from 'fast-check';

import { resolveAppMode } from './app-lock';
import { DEFAULT_LOCKOUT_POLICY, evaluateLockout } from './lockout-policy';
import { getPbkdf2Provider, hashSecret, setPbkdf2Provider, type Pbkdf2Provider } from './secret-hash';

/**
 * Property tests for decoy / lockout indistinguishability (Feature: ui-modernization-and-setup-fix,
 * Property 9). Confirms the freeze fix (the injected `Pbkdf2Provider`) leaves the security
 * resolution unchanged: `resolveAppMode` checks the real verifier first, returns `decoy` only when
 * just the decoy matches, and `null` otherwise; and the 5-failure / 10-minute -> 30-minute lockout
 * is unchanged. Validates Requirement 4.3.
 *
 * (The `revealHiddenChat` check-all-candidates behaviour, Requirement 4.6, lives in the mobile
 * `secure-gate` module and is covered alongside its own tasks; this pure-core test exercises the
 * shared resolution + lockout math that the freeze fix must not perturb.)
 */

const ITER = 1000;

/** Use Node's native PBKDF2 so the real-verification sweep stays fast across many runs. */
const DEFAULT_PROVIDER = getPbkdf2Provider();
const fastNativeProvider: Pbkdf2Provider = {
  deriveBits(password, salt, iterations, keyLenBytes) {
    return new Promise((resolve, reject) => {
      pbkdf2(Buffer.from(password), Buffer.from(salt), iterations, keyLenBytes, 'sha256', (err, derived) =>
        err || derived == null ? reject(err ?? new Error('pbkdf2 failed')) : resolve(new Uint8Array(derived)),
      );
    });
  },
};

const MIN = 60 * 1000;

test('Property 9: resolveAppMode — real checked first, decoy only, else null', async () => {
  setPbkdf2Provider(fastNativeProvider);
  try {
    await fc.assert(
      fc.asyncProperty(
        // Three distinct, non-empty PINs so the three branches are unambiguous.
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 12 }), { minLength: 3, maxLength: 3 }),
        async ([realPin, decoyPin, otherPin]) => {
          const real = await hashSecret(realPin, ITER);
          const decoy = await hashSecret(decoyPin, ITER);

          // The real PIN opens the real app (real verifier is checked first).
          assert.equal(await resolveAppMode(realPin, { real, decoy }), 'real');
          // The decoy PIN opens the decoy state when only the decoy matches.
          assert.equal(await resolveAppMode(decoyPin, { real, decoy }), 'decoy');
          // A PIN matching neither resolves to null.
          assert.equal(await resolveAppMode(otherPin, { real, decoy }), null);

          // When the same PIN is configured for both, the real app wins (checked first).
          const decoySameAsReal = await hashSecret(realPin, ITER);
          assert.equal(await resolveAppMode(realPin, { real, decoy: decoySameAsReal }), 'real');
        },
      ),
      { numRuns: 100 },
    );
  } finally {
    setPbkdf2Provider(DEFAULT_PROVIDER);
  }
});

test('Property 9: lockout policy unchanged — 5 failures / 10 min -> 30 min lockout', () => {
  // The default policy constants are exactly 5 / 10min / 30min.
  assert.deepEqual(DEFAULT_LOCKOUT_POLICY, { windowMs: 10 * MIN, maxFailures: 5, lockoutMs: 30 * MIN });

  fc.assert(
    fc.property(
      fc.integer({ min: 1_700_000_000_000, max: 1_900_000_000_000 }),
      // 5..12 failures, each within the trailing 10-minute window (0..9 minutes before `now`).
      fc.array(fc.integer({ min: 0, max: 9 * MIN - 1 }), { minLength: 5, maxLength: 12 }),
      (now, offsets) => {
        const fails = offsets.map((o) => now - o);
        const state = evaluateLockout(fails, now);
        const lastFailure = Math.max(...fails);

        // >= 5 failures inside the window => locked until last failure + 30 min.
        assert.equal(state.locked, true);
        assert.equal(state.lockedUntil, lastFailure + 30 * MIN);
        assert.equal(state.msUntilUnlock, lastFailure + 30 * MIN - now);
        assert.ok(state.failuresInWindow >= 5);
      },
    ),
    { numRuns: 100 },
  );

  // Fewer than 5 failures in the window never locks, regardless of placement.
  fc.assert(
    fc.property(
      fc.integer({ min: 1_700_000_000_000, max: 1_900_000_000_000 }),
      fc.array(fc.integer({ min: 0, max: 9 * MIN - 1 }), { minLength: 0, maxLength: 4 }),
      (now, offsets) => {
        const fails = offsets.map((o) => now - o);
        assert.equal(evaluateLockout(fails, now).locked, false);
      },
    ),
    { numRuns: 100 },
  );
});
