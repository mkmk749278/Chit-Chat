import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeSafetyNumber } from './safety-number';

/**
 * Property tests for the safety-number generator (Phase 2, Requirement 1). These run under
 * `node --test` with Node's global WebCrypto (`crypto.subtle`), the same SHA-512 surface the
 * browser and the RN msrcrypto polyfill provide, so the behaviour proven here is the behaviour
 * shipped to both clients.
 */

const keyA = new Uint8Array(32).fill(7);
const keyB = Uint8Array.from({ length: 32 }, (_v, i) => (i * 31 + 5) & 0xff);

test('safety number is 60 digits, formatted as 12 space-separated blocks of 5', async () => {
  const sn = await computeSafetyNumber({
    localUid: 'alice',
    localIdentityKey: keyA,
    remoteUid: 'bob',
    remoteIdentityKey: keyB,
  });
  assert.match(sn.raw, /^\d{60}$/);
  const blocks = sn.formatted.split(' ');
  assert.equal(blocks.length, 12);
  assert.ok(blocks.every((b) => /^\d{5}$/.test(b)));
  assert.equal(blocks.join(''), sn.raw);
});

test('deterministic: identical inputs yield an identical number', async () => {
  const input = {
    localUid: 'alice',
    localIdentityKey: keyA,
    remoteUid: 'bob',
    remoteIdentityKey: keyB,
  };
  const first = await computeSafetyNumber(input);
  const second = await computeSafetyNumber(input);
  assert.equal(first.raw, second.raw);
});

test('symmetric: both devices compute the same number with local/remote swapped', async () => {
  const aliceSide = await computeSafetyNumber({
    localUid: 'alice',
    localIdentityKey: keyA,
    remoteUid: 'bob',
    remoteIdentityKey: keyB,
  });
  const bobSide = await computeSafetyNumber({
    localUid: 'bob',
    localIdentityKey: keyB,
    remoteUid: 'alice',
    remoteIdentityKey: keyA,
  });
  assert.equal(aliceSide.raw, bobSide.raw);
});

test('changing an identity key changes the safety number (MITM detection)', async () => {
  const genuine = await computeSafetyNumber({
    localUid: 'alice',
    localIdentityKey: keyA,
    remoteUid: 'bob',
    remoteIdentityKey: keyB,
  });
  const tamperedKey = Uint8Array.from(keyB);
  tamperedKey[0] ^= 0x01; // flip a single bit of the peer's identity key
  const mitm = await computeSafetyNumber({
    localUid: 'alice',
    localIdentityKey: keyA,
    remoteUid: 'bob',
    remoteIdentityKey: tamperedKey,
  });
  assert.notEqual(genuine.raw, mitm.raw);
});

test('changing a UID (stable identifier) changes the safety number', async () => {
  const a = await computeSafetyNumber({
    localUid: 'alice',
    localIdentityKey: keyA,
    remoteUid: 'bob',
    remoteIdentityKey: keyB,
  });
  const b = await computeSafetyNumber({
    localUid: 'alice',
    localIdentityKey: keyA,
    remoteUid: 'bob-2',
    remoteIdentityKey: keyB,
  });
  assert.notEqual(a.raw, b.raw);
});

test('empty identity key is rejected', async () => {
  await assert.rejects(
    computeSafetyNumber({
      localUid: 'alice',
      localIdentityKey: new Uint8Array(0),
      remoteUid: 'bob',
      remoteIdentityKey: keyB,
    }),
    /non-empty/,
  );
});
