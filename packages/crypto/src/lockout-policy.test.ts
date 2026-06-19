import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_LOCKOUT_POLICY, evaluateLockout, pruneFailures } from './lockout-policy';

/**
 * Tests for the unlock rate-limit / lockout policy (Signature Features 1 & 4, §3.1/§6.2):
 * 5 wrong attempts per 10 minutes → 30-minute lockout. Pure + clock-injected.
 */

const MIN = 60 * 1000;
const NOW = 1_700_000_000_000;

test('default policy is 5 failures / 10 min → 30 min lockout', () => {
  assert.deepEqual(DEFAULT_LOCKOUT_POLICY, { windowMs: 10 * MIN, maxFailures: 5, lockoutMs: 30 * MIN });
});

test('fewer than 5 failures in the window is not locked', () => {
  const fails = [NOW - 4 * MIN, NOW - 3 * MIN, NOW - 2 * MIN, NOW - MIN];
  const state = evaluateLockout(fails, NOW);
  assert.equal(state.locked, false);
  assert.equal(state.failuresInWindow, 4);
});

test('5 failures within 10 minutes locks for 30 minutes from the last failure', () => {
  const fails = [NOW - 4 * MIN, NOW - 3 * MIN, NOW - 2 * MIN, NOW - MIN, NOW];
  const state = evaluateLockout(fails, NOW);
  assert.equal(state.locked, true);
  assert.equal(state.lockedUntil, NOW + 30 * MIN);
  assert.equal(state.msUntilUnlock, 30 * MIN);
});

test('the lock lifts after the lockout window elapses', () => {
  const fifthAt = NOW;
  const fails = [NOW - 4 * MIN, NOW - 3 * MIN, NOW - 2 * MIN, NOW - MIN, fifthAt];
  // 31 minutes later the lock has expired and old failures have aged out of the window.
  const later = fifthAt + 31 * MIN;
  const state = evaluateLockout(fails, later);
  assert.equal(state.locked, false);
  assert.equal(state.failuresInWindow, 0);
});

test('failures older than the window do not count toward a lockout', () => {
  // Five failures, but spread over more than 10 minutes so never 5 within the window.
  const fails = [NOW - 30 * MIN, NOW - 22 * MIN, NOW - 15 * MIN, NOW - 9 * MIN, NOW - MIN];
  const state = evaluateLockout(fails, NOW);
  assert.equal(state.locked, false);
  assert.equal(state.failuresInWindow, 2); // only the last two are within 10 min
});

test('future-dated timestamps are ignored', () => {
  const fails = [NOW + MIN, NOW + 2 * MIN, NOW + 3 * MIN, NOW + 4 * MIN, NOW + 5 * MIN];
  assert.equal(evaluateLockout(fails, NOW).failuresInWindow, 0);
});

test('pruneFailures drops timestamps that can no longer affect a decision', () => {
  const fails = [NOW - 90 * MIN, NOW - 31 * MIN, NOW - 5 * MIN, NOW - MIN];
  const kept = pruneFailures(fails, NOW);
  // horizon = now - max(window, lockout) = now - 30min, so anything older than 30min is dropped.
  assert.deepEqual(kept, [NOW - 5 * MIN, NOW - MIN]);
});

test('a custom policy is honoured', () => {
  const policy = { windowMs: 60 * 1000, maxFailures: 3, lockoutMs: 5 * 60 * 1000 };
  const fails = [NOW - 30 * 1000, NOW - 20 * 1000, NOW - 10 * 1000];
  const state = evaluateLockout(fails, NOW, policy);
  assert.equal(state.locked, true);
  assert.equal(state.lockedUntil, NOW - 10 * 1000 + 5 * 60 * 1000);
});
