/**
 * `@chat-app/crypto` — per-attachment encryption (Phase 2, Requirement 7).
 *
 * Verifies the AES-256-GCM round-trip, that each attachment gets a fresh key + iv, and that
 * tampering / a wrong key / a wrong iv is rejected (authenticated encryption), so the blob store
 * holding only ciphertext can never yield readable or silently-corrupt content.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decryptAttachment, encryptAttachment } from './attachment-crypto';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

test('encrypt → decrypt round-trips the original bytes', async () => {
  const plaintext = bytes('hello 📎 attachment bytes');
  const enc = await encryptAttachment(plaintext);
  assert.equal(enc.key.length, 32);
  assert.equal(enc.iv.length, 12);
  // Ciphertext must not equal plaintext and includes the GCM tag (longer than input).
  assert.notDeepEqual(enc.ciphertext, plaintext);
  assert.ok(enc.ciphertext.length > plaintext.length);

  const out = await decryptAttachment({ ciphertext: enc.ciphertext, key: enc.key, iv: enc.iv });
  assert.deepEqual(out, plaintext);
});

test('round-trips empty content', async () => {
  const enc = await encryptAttachment(new Uint8Array());
  const out = await decryptAttachment(enc);
  assert.equal(out.length, 0);
});

test('each call uses a fresh random key and iv', async () => {
  const a = await encryptAttachment(bytes('x'));
  const b = await encryptAttachment(bytes('x'));
  assert.notDeepEqual(a.key, b.key);
  assert.notDeepEqual(a.iv, b.iv);
  // Same plaintext under different key/iv → different ciphertext.
  assert.notDeepEqual(a.ciphertext, b.ciphertext);
});

test('tampered ciphertext is rejected (GCM auth)', async () => {
  const enc = await encryptAttachment(bytes('sensitive'));
  enc.ciphertext[0] ^= 0xff;
  await assert.rejects(() => decryptAttachment(enc));
});

test('a wrong key is rejected', async () => {
  const enc = await encryptAttachment(bytes('sensitive'));
  const wrongKey = new Uint8Array(32).fill(7);
  await assert.rejects(() => decryptAttachment({ ciphertext: enc.ciphertext, key: wrongKey, iv: enc.iv }));
});

test('a wrong iv is rejected', async () => {
  const enc = await encryptAttachment(bytes('sensitive'));
  const wrongIv = new Uint8Array(12).fill(9);
  await assert.rejects(() => decryptAttachment({ ciphertext: enc.ciphertext, key: enc.key, iv: wrongIv }));
});

test('decrypt rejects a malformed key/iv length before touching WebCrypto', async () => {
  const enc = await encryptAttachment(bytes('x'));
  await assert.rejects(() => decryptAttachment({ ciphertext: enc.ciphertext, key: new Uint8Array(16), iv: enc.iv }));
  await assert.rejects(() => decryptAttachment({ ciphertext: enc.ciphertext, key: enc.key, iv: new Uint8Array(8) }));
});
