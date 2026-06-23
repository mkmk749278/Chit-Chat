import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeContentPayload, encodeContentPayload, type ContentPayload } from './content-payload';

/**
 * Codec tests for the biometric-presence-attestation control payloads (Signature Feature 2b, §4.5).
 * They ride inside the E2E ciphertext like the other verify-* controls, so they must round-trip
 * exactly and — being total — any malformed inbound variant must decode to `{type:'unsupported'}`
 * (ignored) rather than throw or misrender.
 */

const roundTrip = (payload: ContentPayload): ContentPayload =>
  decodeContentPayload(encodeContentPayload(payload)).payload;

test('bioverify-enroll round-trips', () => {
  const payload: ContentPayload = { type: 'bioverify-enroll', attestKey: 'QUJD' };
  assert.deepEqual(roundTrip(payload), payload);
});

test('bioverify-request round-trips', () => {
  const payload: ContentPayload = { type: 'bioverify-request', challenge: 'Y2hhbGxlbmdl' };
  assert.deepEqual(roundTrip(payload), payload);
});

test('bioverify-response round-trips (available, with signature)', () => {
  const payload: ContentPayload = {
    type: 'bioverify-response',
    challenge: 'Y2hhbGxlbmdl',
    issuedAt: 1_700_000_000_000,
    signature: 'c2ln',
    available: true,
  };
  assert.deepEqual(roundTrip(payload), payload);
});

test('bioverify-response round-trips (unavailable, empty signature)', () => {
  const payload: ContentPayload = {
    type: 'bioverify-response',
    challenge: 'Y2hhbGxlbmdl',
    issuedAt: 1_700_000_000_000,
    signature: '',
    available: false,
  };
  assert.deepEqual(roundTrip(payload), payload);
});

test('malformed bioverify-enroll (empty/missing key) decodes to unsupported', () => {
  assert.deepEqual(
    decodeContentPayload(JSON.stringify({ v: 1, type: 'bioverify-enroll', attestKey: '' })).payload,
    { type: 'unsupported' },
  );
  assert.deepEqual(
    decodeContentPayload(JSON.stringify({ v: 1, type: 'bioverify-enroll' })).payload,
    { type: 'unsupported' },
  );
});

test('malformed bioverify-request (non-string challenge) decodes to unsupported', () => {
  assert.deepEqual(
    decodeContentPayload(JSON.stringify({ v: 1, type: 'bioverify-request', challenge: 42 })).payload,
    { type: 'unsupported' },
  );
});

test('malformed bioverify-response (missing fields / wrong types) decodes to unsupported', () => {
  // Missing `available`.
  assert.deepEqual(
    decodeContentPayload(
      JSON.stringify({ v: 1, type: 'bioverify-response', challenge: 'x', issuedAt: 1, signature: 's' }),
    ).payload,
    { type: 'unsupported' },
  );
  // `signature` not a string.
  assert.deepEqual(
    decodeContentPayload(
      JSON.stringify({ v: 1, type: 'bioverify-response', challenge: 'x', issuedAt: 1, signature: 5, available: true }),
    ).payload,
    { type: 'unsupported' },
  );
  // `issuedAt` not finite.
  assert.deepEqual(
    decodeContentPayload(
      JSON.stringify({ v: 1, type: 'bioverify-response', challenge: 'x', issuedAt: 'soon', signature: 's', available: true }),
    ).payload,
    { type: 'unsupported' },
  );
});
