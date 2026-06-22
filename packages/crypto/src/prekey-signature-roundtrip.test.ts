/**
 * Roundtrip test for signed-prekey verification (Req 2.9). This is the de-risking test for replacing
 * the Phase-0 placeholder with real libsignal verification: it drives the SAME keygen the clients use
 * (`createPureTsLibsignalKeyGen`) to produce a genuine identity key + signed prekey + signature, then
 * asserts {@link verifySignedPreKeySignature} ACCEPTS it and REJECTS every tampering — proving the
 * byte formats agree end-to-end (a mismatch here would reject legitimate device registrations).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { verifySignedPreKeySignature } from './index';
import { createPureTsLibsignalKeyGen } from './libsignal-puretsignal';

const keygen = createPureTsLibsignalKeyGen();

/** Generate a real identity + signed prekey + signature over the signed prekey's public key. */
async function makeSignedPreKey(): Promise<{
  identityPublicKey: Uint8Array;
  signedPreKeyPublicKey: Uint8Array;
  signature: Uint8Array;
}> {
  const identity = await keygen.generateIdentityKeyPair();
  const signedPreKey = await keygen.generatePreKeyPair();
  const signature = await keygen.signWithIdentity(identity.privateKey, signedPreKey.publicKey);
  return {
    identityPublicKey: identity.publicKey,
    signedPreKeyPublicKey: signedPreKey.publicKey,
    signature,
  };
}

test('accepts a genuine signed-prekey signature from the real keygen (bytes)', async () => {
  const { identityPublicKey, signedPreKeyPublicKey, signature } = await makeSignedPreKey();
  assert.equal(
    await verifySignedPreKeySignature(identityPublicKey, signedPreKeyPublicKey, signature),
    true,
  );
});

test('accepts the same signature through the base64 (on-the-wire) shape', async () => {
  const { identityPublicKey, signedPreKeyPublicKey, signature } = await makeSignedPreKey();
  const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
  assert.equal(
    await verifySignedPreKeySignature(b64(identityPublicKey), b64(signedPreKeyPublicKey), b64(signature)),
    true,
  );
});

test('rejects a signature verified against the WRONG identity key', async () => {
  const a = await makeSignedPreKey();
  const b = await makeSignedPreKey();
  // b's identity did not sign a's signed prekey.
  assert.equal(
    await verifySignedPreKeySignature(b.identityPublicKey, a.signedPreKeyPublicKey, a.signature),
    false,
  );
});

test('rejects a tampered signature', async () => {
  const { identityPublicKey, signedPreKeyPublicKey, signature } = await makeSignedPreKey();
  const tampered = Uint8Array.from(signature);
  tampered[0] ^= 0xff; // flip one bit
  assert.equal(
    await verifySignedPreKeySignature(identityPublicKey, signedPreKeyPublicKey, tampered),
    false,
  );
});

test('rejects when the signed prekey public key was altered after signing', async () => {
  const { identityPublicKey, signedPreKeyPublicKey, signature } = await makeSignedPreKey();
  const altered = Uint8Array.from(signedPreKeyPublicKey);
  altered[altered.length - 1] ^= 0x01;
  assert.equal(await verifySignedPreKeySignature(identityPublicKey, altered, signature), false);
});
