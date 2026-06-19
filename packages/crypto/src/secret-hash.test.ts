import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_SECRET_ITERATIONS, hashSecret, verifySecret } from './secret-hash';

/**
 * Tests for salted secret hashing (Signature Features 1 & 4, §3.1/§6). Run under `node --test`
 * with Node's global WebCrypto — the same PBKDF2 surface the browser and the RN polyfill provide.
 * Use a low iteration count so the suite stays fast; the algorithm is identical to production.
 */

const ITER = 1000;

test('a correct secret verifies; a wrong one does not', async () => {
  const stored = await hashSecret('open sesame', ITER);
  assert.equal(await verifySecret('open sesame', stored), true);
  assert.equal(await verifySecret('open Sesame', stored), false);
  assert.equal(await verifySecret('', stored), false);
});

test('the stored verifier is salted: same secret hashes differently each time', async () => {
  const a = await hashSecret('1234', ITER);
  const b = await hashSecret('1234', ITER);
  assert.notEqual(a, b);
  // ...yet both verify the original secret.
  assert.equal(await verifySecret('1234', a), true);
  assert.equal(await verifySecret('1234', b), true);
});

test('the verifier never contains the plaintext secret', async () => {
  const secret = 'super-secret-passphrase';
  const stored = await hashSecret(secret, ITER);
  assert.ok(!stored.includes(secret));
});

test('the encoded format is self-describing (scheme$hash$iters$salt$hash)', async () => {
  const stored = await hashSecret('pin', ITER);
  const parts = stored.split('$');
  assert.equal(parts.length, 5);
  assert.equal(parts[0], 'pbkdf2');
  assert.equal(parts[1], 'sha256');
  assert.equal(Number.parseInt(parts[2], 10), ITER);
});

test('a malformed or foreign verifier returns false, never throws', async () => {
  assert.equal(await verifySecret('x', 'not-a-verifier'), false);
  assert.equal(await verifySecret('x', 'pbkdf2$sha256$abc$salt$hash'), false);
  assert.equal(await verifySecret('x', 'bcrypt$sha256$1000$c2FsdA==$aGFzaA=='), false);
  assert.equal(await verifySecret('x', ''), false);
});

test('an empty secret cannot be hashed', async () => {
  await assert.rejects(() => hashSecret('', ITER), /non-empty/);
});

test('the default iteration count is high enough to be a real KDF', () => {
  assert.ok(DEFAULT_SECRET_ITERATIONS >= 100_000);
});
