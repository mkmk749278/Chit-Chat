import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveAppMode } from './app-lock';
import { hashSecret } from './secret-hash';

/** Tests for decoy-PIN resolution (Signature Feature 4, §6). */

const ITER = 1000;

test('the real PIN opens the real app', async () => {
  const real = await hashSecret('1234', ITER);
  const decoy = await hashSecret('9999', ITER);
  assert.equal(await resolveAppMode('1234', { real, decoy }), 'real');
});

test('the decoy PIN opens the decoy state', async () => {
  const real = await hashSecret('1234', ITER);
  const decoy = await hashSecret('9999', ITER);
  assert.equal(await resolveAppMode('9999', { real, decoy }), 'decoy');
});

test('a wrong PIN resolves to null (indistinguishable from no decoy configured)', async () => {
  const real = await hashSecret('1234', ITER);
  assert.equal(await resolveAppMode('0000', { real, decoy: null }), null);
  assert.equal(await resolveAppMode('0000', { real }), null);
});

test('an empty PIN never resolves', async () => {
  const real = await hashSecret('1234', ITER);
  assert.equal(await resolveAppMode('', { real }), null);
});

test('with no real PIN configured, nothing resolves', async () => {
  assert.equal(await resolveAppMode('1234', { real: null }), null);
});

test('if the same PIN were set for both, the real app wins (deterministic)', async () => {
  const same = await hashSecret('1111', ITER);
  // Two independent verifiers for the same PIN (different salts) — both verify '1111'.
  const decoy = await hashSecret('1111', ITER);
  assert.equal(await resolveAppMode('1111', { real: same, decoy }), 'real');
});
