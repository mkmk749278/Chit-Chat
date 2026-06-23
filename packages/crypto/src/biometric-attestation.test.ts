import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BIOVERIFY_CHALLENGE_BYTES,
  BIOVERIFY_FRESHNESS_MS,
  buildAttestationMessage,
  generateBioVerifyChallenge,
  verifyBioAttestation,
  type BioAttestationContext,
} from './biometric-attestation';
import { createPureTsLibsignalKeyGen } from './libsignal-puretsignal';

/**
 * Unit tests for biometric presence attestation (Signature Feature 2b, §4.5). The signature is a
 * real Curve25519/XEdDSA signature — produced here with the same `LibsignalKeyGen` the device's
 * attestor uses — so these prove the genuine sign→verify behaviour and every failure mode
 * (`challenge-mismatch` replay, `stale` window, `bad-signature` forgery/borrowed-device).
 */

const keyGen = createPureTsLibsignalKeyGen();
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/** Mint a fresh Curve25519 attestation key pair (mirrors the device attestor's key). */
async function newAttestationKey(): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array }> {
  return keyGen.generateIdentityKeyPair();
}

/** Sign a context the way the attester device would (live-biometric-gated key signs the message). */
async function signContext(privateKey: Uint8Array, ctx: BioAttestationContext): Promise<string> {
  const message = buildAttestationMessage(ctx);
  return b64(await keyGen.signWithIdentity(privateKey, message));
}

test('generateBioVerifyChallenge yields distinct 32-byte nonces', () => {
  const a = generateBioVerifyChallenge();
  const b = generateBioVerifyChallenge();
  assert.notEqual(a, b);
  assert.equal(Buffer.from(a, 'base64').length, BIOVERIFY_CHALLENGE_BYTES);
  assert.equal(Buffer.from(b, 'base64').length, BIOVERIFY_CHALLENGE_BYTES);
});

test('buildAttestationMessage is deterministic for the same context', () => {
  const ctx: BioAttestationContext = {
    challenge: generateBioVerifyChallenge(),
    verifierUid: 'alice',
    attesterUid: 'bob',
    issuedAt: 1_700_000_000_000,
  };
  assert.deepEqual(buildAttestationMessage(ctx), buildAttestationMessage(ctx));
});

test('buildAttestationMessage binds the uids unambiguously (no field-boundary collision)', () => {
  const challenge = generateBioVerifyChallenge();
  const issuedAt = 1_700_000_000_000;
  // Swapping characters between the two uids must change the signed bytes — length-prefixing
  // guarantees ("ab","c") and ("a","bc") cannot serialize to the same message.
  const m1 = buildAttestationMessage({ challenge, verifierUid: 'ab', attesterUid: 'c', issuedAt });
  const m2 = buildAttestationMessage({ challenge, verifierUid: 'a', attesterUid: 'bc', issuedAt });
  assert.notDeepEqual(m1, m2);
});

test('a genuine live-biometric proof verifies', async () => {
  const key = await newAttestationKey();
  const challenge = generateBioVerifyChallenge();
  const issuedAt = 1_700_000_000_000;
  const signature = await signContext(key.privateKey, {
    challenge,
    verifierUid: 'alice',
    attesterUid: 'bob',
    issuedAt,
  });
  const outcome = await verifyBioAttestation({
    expectedChallenge: challenge,
    verifierUid: 'alice',
    attesterUid: 'bob',
    response: { challenge, issuedAt, signature },
    attesterPublicKey: key.publicKey,
    now: issuedAt,
  });
  assert.equal(outcome, 'verified');
});

test('a response that echoes the wrong challenge is a replay → challenge-mismatch', async () => {
  const key = await newAttestationKey();
  const issuedAt = 1_700_000_000_000;
  const signedChallenge = generateBioVerifyChallenge();
  const signature = await signContext(key.privateKey, {
    challenge: signedChallenge,
    verifierUid: 'alice',
    attesterUid: 'bob',
    issuedAt,
  });
  const outcome = await verifyBioAttestation({
    expectedChallenge: generateBioVerifyChallenge(), // a DIFFERENT challenge than the one signed
    verifierUid: 'alice',
    attesterUid: 'bob',
    response: { challenge: signedChallenge, issuedAt, signature },
    attesterPublicKey: key.publicKey,
    now: issuedAt,
  });
  assert.equal(outcome, 'challenge-mismatch');
});

test('a stale (or future) signing time is rejected; within the window passes', async () => {
  const key = await newAttestationKey();
  const challenge = generateBioVerifyChallenge();
  const issuedAt = 1_700_000_000_000;
  const signature = await signContext(key.privateKey, {
    challenge,
    verifierUid: 'alice',
    attesterUid: 'bob',
    issuedAt,
  });
  const base = {
    expectedChallenge: challenge,
    verifierUid: 'alice',
    attesterUid: 'bob',
    response: { challenge, issuedAt, signature },
    attesterPublicKey: key.publicKey,
  };
  // Too old, and implausibly in the future, both rejected.
  assert.equal(await verifyBioAttestation({ ...base, now: issuedAt + BIOVERIFY_FRESHNESS_MS + 1 }), 'stale');
  assert.equal(await verifyBioAttestation({ ...base, now: issuedAt - BIOVERIFY_FRESHNESS_MS - 1 }), 'stale');
  // Just inside the window still verifies.
  assert.equal(await verifyBioAttestation({ ...base, now: issuedAt + BIOVERIFY_FRESHNESS_MS }), 'verified');
});

test('a forged signature (different key than enrolled) → bad-signature', async () => {
  const real = await newAttestationKey();
  const impostor = await newAttestationKey();
  const challenge = generateBioVerifyChallenge();
  const issuedAt = 1_700_000_000_000;
  // The impostor signs a perfectly-formed message, but with the WRONG private key.
  const signature = await signContext(impostor.privateKey, {
    challenge,
    verifierUid: 'alice',
    attesterUid: 'bob',
    issuedAt,
  });
  const outcome = await verifyBioAttestation({
    expectedChallenge: challenge,
    verifierUid: 'alice',
    attesterUid: 'bob',
    response: { challenge, issuedAt, signature },
    attesterPublicKey: real.publicKey, // the ENROLLED (real) key
    now: issuedAt,
  });
  assert.equal(outcome, 'bad-signature');
});

test('tampering with the bound uid invalidates the signature → bad-signature', async () => {
  const key = await newAttestationKey();
  const challenge = generateBioVerifyChallenge();
  const issuedAt = 1_700_000_000_000;
  const signature = await signContext(key.privateKey, {
    challenge,
    verifierUid: 'alice',
    attesterUid: 'bob',
    issuedAt,
  });
  // Verify against a DIFFERENT verifierUid than was signed: the reconstructed message differs.
  const outcome = await verifyBioAttestation({
    expectedChallenge: challenge,
    verifierUid: 'mallory',
    attesterUid: 'bob',
    response: { challenge, issuedAt, signature },
    attesterPublicKey: key.publicKey,
    now: issuedAt,
  });
  assert.equal(outcome, 'bad-signature');
});

test('malformed signature / empty key never throws, resolves bad-signature', async () => {
  const key = await newAttestationKey();
  const challenge = generateBioVerifyChallenge();
  const issuedAt = 1_700_000_000_000;
  assert.equal(
    await verifyBioAttestation({
      expectedChallenge: challenge,
      verifierUid: 'alice',
      attesterUid: 'bob',
      response: { challenge, issuedAt, signature: '' },
      attesterPublicKey: key.publicKey,
      now: issuedAt,
    }),
    'bad-signature',
  );
  assert.equal(
    await verifyBioAttestation({
      expectedChallenge: challenge,
      verifierUid: 'alice',
      attesterUid: 'bob',
      response: { challenge, issuedAt, signature: 'not really base64 !!!' },
      attesterPublicKey: new Uint8Array(0),
      now: issuedAt,
    }),
    'bad-signature',
  );
});
