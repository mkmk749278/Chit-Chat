import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  VERIFICATION_STEP_SECONDS,
  classifyVerificationCode,
  currentVerificationCodes,
  generateVerificationSeed,
  hotp,
  msUntilNextCode,
  verificationSeedFromBase64,
  verificationSeedToBase64,
} from './identity-verification';

/**
 * Tests for in-chat identity verification (Signature Feature 2, requirements §4). Run under
 * `node --test` with Node's global WebCrypto — the same HMAC surface the browser and the RN
 * msrcrypto polyfill provide — so the codes proven here are the codes shipped to both clients.
 */

const seed = Uint8Array.from({ length: 32 }, (_v, i) => (i * 37 + 11) & 0xff);

// RFC 4226 Appendix D HOTP test vectors for the ASCII secret "12345678901234567890".
const RFC4226_KEY = new TextEncoder().encode('12345678901234567890');
const RFC4226_HOTP = [
  '755224', '287082', '359152', '969429', '338314',
  '254676', '287922', '162583', '399871', '520489',
];

test('hotp matches the RFC 4226 Appendix-D test vectors (counters 0..9)', async () => {
  for (let counter = 0; counter < RFC4226_HOTP.length; counter += 1) {
    assert.equal(await hotp(RFC4226_KEY, counter), RFC4226_HOTP[counter]);
  }
});

test('current codes are 6-digit numeric strings', async () => {
  const codes = await currentVerificationCodes(seed, 1_700_000_000_000);
  assert.match(codes.normal, /^\d{6}$/);
  assert.match(codes.duress, /^\d{6}$/);
});

test('normal and duress codes differ (independent streams from the one seed)', async () => {
  const codes = await currentVerificationCodes(seed, 1_700_000_000_000);
  assert.notEqual(codes.normal, codes.duress);
});

test('codes are deterministic for the same seed + step, symmetric across both peers', async () => {
  const t = 1_700_000_000_000;
  const a = await currentVerificationCodes(seed, t);
  const b = await currentVerificationCodes(seed, t + 5_000); // same 60 s step
  assert.deepEqual(a, b);
});

test('codes rotate at the step boundary (no replay across steps, §4.2)', async () => {
  const stepMs = VERIFICATION_STEP_SECONDS * 1000;
  const base = 1_700_000_040_000; // arbitrary
  const step0 = await currentVerificationCodes(seed, base);
  const step1 = await currentVerificationCodes(seed, base + stepMs);
  assert.notEqual(step0.normal, step1.normal);
  assert.notEqual(step0.duress, step1.duress);
});

test('a different seed yields different codes', async () => {
  const other = Uint8Array.from({ length: 32 }, (_v, i) => (i * 91 + 3) & 0xff);
  const t = 1_700_000_000_000;
  const a = await currentVerificationCodes(seed, t);
  const b = await currentVerificationCodes(other, t);
  assert.notEqual(a.normal, b.normal);
});

test('classify recognises the normal code in the current step', async () => {
  const t = 1_700_000_000_000;
  const { normal } = await currentVerificationCodes(seed, t);
  assert.equal(await classifyVerificationCode(seed, normal, t), 'normal');
});

test('classify recognises the duress code and prioritises it (§4.3)', async () => {
  const t = 1_700_000_000_000;
  const { duress } = await currentVerificationCodes(seed, t);
  assert.equal(await classifyVerificationCode(seed, duress, t), 'duress');
});

test('classify rejects a wrong code as invalid', async () => {
  const t = 1_700_000_000_000;
  assert.equal(await classifyVerificationCode(seed, '000000', t, { skewSteps: 0 }), 'invalid');
  assert.equal(await classifyVerificationCode(seed, 'abc', t), 'invalid');
  assert.equal(await classifyVerificationCode(seed, '', t), 'invalid');
});

test('classify accepts the previous/next step within the skew window, rejects beyond it', async () => {
  const stepMs = VERIFICATION_STEP_SECONDS * 1000;
  const t = 1_700_000_060_000;
  const prev = await currentVerificationCodes(seed, t - stepMs);
  // Default window is ±1 step, so the previous step's code still verifies.
  assert.equal(await classifyVerificationCode(seed, prev.normal, t), 'normal');
  // Two steps back is outside the ±1 window.
  const twoBack = await currentVerificationCodes(seed, t - 2 * stepMs);
  assert.equal(await classifyVerificationCode(seed, twoBack.normal, t, { skewSteps: 1 }), 'invalid');
});

test('a captured code does not replay two steps later (rotation + bounded window)', async () => {
  const stepMs = VERIFICATION_STEP_SECONDS * 1000;
  const t = 1_700_000_000_000;
  const { normal } = await currentVerificationCodes(seed, t);
  assert.equal(await classifyVerificationCode(seed, normal, t + 3 * stepMs), 'invalid');
});

test('seed generation is 32 random bytes and round-trips through base64', () => {
  const a = generateVerificationSeed();
  const b = generateVerificationSeed();
  assert.equal(a.length, 32);
  assert.notDeepEqual(a, b); // overwhelmingly likely distinct
  const restored = verificationSeedFromBase64(verificationSeedToBase64(a));
  assert.deepEqual(restored, a);
});

test('msUntilNextCode is always within (0, step*1000] and counts down within a step', () => {
  const stepMs = VERIFICATION_STEP_SECONDS * 1000;
  // Exactly on a boundary → a full period remains.
  assert.equal(msUntilNextCode(0), stepMs);
  assert.equal(msUntilNextCode(stepMs), stepMs);
  // 10 s into a step → 50 s remain.
  assert.equal(msUntilNextCode(10_000), stepMs - 10_000);
  for (const t of [1, 12_345, 59_999, 1_700_000_001_234]) {
    const ms = msUntilNextCode(t);
    assert.ok(ms > 0 && ms <= stepMs, `expected (0, ${stepMs}] but got ${ms}`);
  }
});
