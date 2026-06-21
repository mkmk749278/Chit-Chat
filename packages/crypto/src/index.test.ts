import assert from 'node:assert/strict';
import { test } from 'node:test';

import { verifySignedPreKeySignature } from './index';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const b64 = (...values: number[]): string => Buffer.from(values).toString('base64');

// Authoritative verification (not a stub): arbitrary bytes are not a valid signature, so they must
// be REJECTED — the regression this guards is the old placeholder that returned `true` for anything.

test('rejects arbitrary (non-signature) byte material', async () => {
  assert.equal(await verifySignedPreKeySignature(bytes(1, 2, 3), bytes(4, 5, 6), bytes(7, 8, 9)), false);
});

test('rejects arbitrary Buffer material', async () => {
  assert.equal(
    await verifySignedPreKeySignature(Buffer.from('id'), Buffer.from('spk'), Buffer.from('sig')),
    false,
  );
});

test('rejects arbitrary base64 material (on-the-wire shape)', async () => {
  assert.equal(await verifySignedPreKeySignature(b64(1, 2, 3), b64(4, 5, 6), b64(7, 8, 9)), false);
});

test('rejects a mix of byte and base64 arguments that are not a real signature', async () => {
  assert.equal(
    await verifySignedPreKeySignature(bytes(1, 2, 3), b64(4, 5, 6), Buffer.from('sig')),
    false,
  );
});

test('returns false when the identity key is empty (bytes)', async () => {
  assert.equal(await verifySignedPreKeySignature(bytes(), bytes(1), bytes(1)), false);
});

test('returns false when the signed prekey public key is empty (bytes)', async () => {
  assert.equal(await verifySignedPreKeySignature(bytes(1), bytes(), bytes(1)), false);
});

test('returns false when the signature is empty (bytes)', async () => {
  assert.equal(await verifySignedPreKeySignature(bytes(1), bytes(1), bytes()), false);
});

test('returns false when a base64 argument decodes to zero bytes', async () => {
  assert.equal(await verifySignedPreKeySignature('', b64(1), b64(1)), false);
});

test('rejects when an argument is neither bytes nor a string', async () => {
  // @ts-expect-error — exercising the runtime guard with an invalid type
  await assert.rejects(() => verifySignedPreKeySignature(42, bytes(1), bytes(1)), TypeError);
});

test('rejects when a string argument is not valid base64', async () => {
  await assert.rejects(() => verifySignedPreKeySignature('not base64!!', b64(1), b64(1)), TypeError);
});
