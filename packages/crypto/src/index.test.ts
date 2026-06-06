import assert from 'node:assert/strict';
import { test } from 'node:test';

import { verifySignedPreKeySignature } from './index';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const b64 = (...values: number[]): string => Buffer.from(values).toString('base64');

test('returns true for well-formed non-empty byte material (Phase 0 stub)', () => {
  const result = verifySignedPreKeySignature(bytes(1, 2, 3), bytes(4, 5, 6), bytes(7, 8, 9));
  assert.equal(result, true);
});

test('accepts Buffer arguments since Buffer extends Uint8Array', () => {
  const result = verifySignedPreKeySignature(
    Buffer.from('id'),
    Buffer.from('spk'),
    Buffer.from('sig'),
  );
  assert.equal(result, true);
});

test('accepts base64 string arguments (on-the-wire prekey shape)', () => {
  const result = verifySignedPreKeySignature(b64(1, 2, 3), b64(4, 5, 6), b64(7, 8, 9));
  assert.equal(result, true);
});

test('accepts a mix of byte and base64 string arguments', () => {
  const result = verifySignedPreKeySignature(bytes(1, 2, 3), b64(4, 5, 6), Buffer.from('sig'));
  assert.equal(result, true);
});

test('returns false when the identity key is empty (bytes)', () => {
  assert.equal(verifySignedPreKeySignature(bytes(), bytes(1), bytes(1)), false);
});

test('returns false when the signed prekey public key is empty (bytes)', () => {
  assert.equal(verifySignedPreKeySignature(bytes(1), bytes(), bytes(1)), false);
});

test('returns false when the signature is empty (bytes)', () => {
  assert.equal(verifySignedPreKeySignature(bytes(1), bytes(1), bytes()), false);
});

test('returns false when a base64 argument decodes to zero bytes', () => {
  assert.equal(verifySignedPreKeySignature('', b64(1), b64(1)), false);
});

test('throws TypeError when an argument is neither bytes nor a string', () => {
  // @ts-expect-error — exercising the runtime guard with an invalid type
  assert.throws(() => verifySignedPreKeySignature(42, bytes(1), bytes(1)), TypeError);
});

test('throws TypeError when a string argument is not valid base64', () => {
  assert.throws(() => verifySignedPreKeySignature('not base64!!', b64(1), b64(1)), TypeError);
});
