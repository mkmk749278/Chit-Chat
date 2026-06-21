import assert from 'node:assert/strict';
import { test } from 'node:test';

import { verifySignedPreKeySignature } from './index';
import { createPureTsLibsignalKeyGen } from './libsignal-puretsignal';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const b64 = (value: Uint8Array): string => Buffer.from(value).toString('base64');

/**
 * Generate a real device key set the way `IdentityManager` does: an identity key pair, a
 * fresh signed-prekey pair, and a Curve25519/XEdDSA signature over the signed prekey's
 * PUBLIC key by the identity PRIVATE key. The same pure-TS engine the clients ship with.
 */
async function generateSignedPreKey(): Promise<{
  identityPublic: Uint8Array;
  signedPreKeyPublic: Uint8Array;
  signature: Uint8Array;
}> {
  const keyGen = createPureTsLibsignalKeyGen();
  const identity = await keyGen.generateIdentityKeyPair();
  const signedPair = await keyGen.generatePreKeyPair();
  const signature = await keyGen.signWithIdentity(identity.privateKey, signedPair.publicKey);
  return {
    identityPublic: identity.publicKey,
    signedPreKeyPublic: signedPair.publicKey,
    signature,
  };
}

test('verifies a genuine signed prekey signature (bytes)', async () => {
  const { identityPublic, signedPreKeyPublic, signature } = await generateSignedPreKey();
  assert.equal(
    await verifySignedPreKeySignature(identityPublic, signedPreKeyPublic, signature),
    true,
  );
});

test('verifies a genuine signed prekey signature (base64, the on-the-wire shape)', async () => {
  const { identityPublic, signedPreKeyPublic, signature } = await generateSignedPreKey();
  assert.equal(
    await verifySignedPreKeySignature(
      b64(identityPublic),
      b64(signedPreKeyPublic),
      b64(signature),
    ),
    true,
  );
});

test('rejects a tampered signature', async () => {
  const { identityPublic, signedPreKeyPublic, signature } = await generateSignedPreKey();
  const tampered = signature.slice();
  tampered[0] ^= 0xff;
  assert.equal(
    await verifySignedPreKeySignature(identityPublic, signedPreKeyPublic, tampered),
    false,
  );
});

test('rejects a signature verified against the wrong identity key', async () => {
  const real = await generateSignedPreKey();
  const other = await generateSignedPreKey();
  assert.equal(
    await verifySignedPreKeySignature(
      other.identityPublic,
      real.signedPreKeyPublic,
      real.signature,
    ),
    false,
  );
});

test('rejects a signature over a tampered signed prekey public key', async () => {
  const { identityPublic, signedPreKeyPublic, signature } = await generateSignedPreKey();
  const tamperedKey = signedPreKeyPublic.slice();
  tamperedKey[tamperedKey.length - 1] ^= 0xff;
  assert.equal(
    await verifySignedPreKeySignature(identityPublic, tamperedKey, signature),
    false,
  );
});

test('returns false when the signature is not 64 bytes', async () => {
  const { identityPublic, signedPreKeyPublic } = await generateSignedPreKey();
  assert.equal(
    await verifySignedPreKeySignature(identityPublic, signedPreKeyPublic, bytes(1, 2, 3)),
    false,
  );
});

test('returns false when the identity key is not a valid Curve25519 public key length', async () => {
  const { signedPreKeyPublic, signature } = await generateSignedPreKey();
  assert.equal(
    await verifySignedPreKeySignature(bytes(1, 2, 3), signedPreKeyPublic, signature),
    false,
  );
});

test('returns false when the signed prekey public key is empty', async () => {
  const { identityPublic, signature } = await generateSignedPreKey();
  assert.equal(await verifySignedPreKeySignature(identityPublic, bytes(), signature), false);
});

test('returns false when the identity key is empty', async () => {
  const { signedPreKeyPublic, signature } = await generateSignedPreKey();
  assert.equal(await verifySignedPreKeySignature(bytes(), signedPreKeyPublic, signature), false);
});

test('rejects when an argument is neither bytes nor a string', async () => {
  await assert.rejects(
    // @ts-expect-error — exercising the runtime guard with an invalid type
    () => verifySignedPreKeySignature(42, bytes(1), bytes(1)),
    TypeError,
  );
});

test('rejects when a string argument is not valid base64', async () => {
  await assert.rejects(
    () => verifySignedPreKeySignature('not base64!!', b64(bytes(1)), b64(bytes(1))),
    TypeError,
  );
});
