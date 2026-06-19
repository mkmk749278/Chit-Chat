import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import {
  CONTENT_PAYLOAD_VERSION,
  decodeContentPayload,
  encodeContentPayload,
  type ContentPayload,
} from './content-payload';

/**
 * Property tests for the Shadow Chat additive `threadId` on the content payload.
 *
 * Feature: shadow-chat. Validates design Correctness Property 6 (surface backward-compatibility,
 * byte-for-byte) and Correctness Property 7 (threadId round-trip + decode totality). Each property
 * runs >=100 randomised iterations and reports the counterexample fast-check produces on failure
 * (Requirements 5.1, 6.1–6.7, 10.2, 10.3, 10.4).
 */

/**
 * The pre-shadow encoder, reproduced verbatim. `encodeContentPayload(p)` with no threadId MUST
 * equal this for every payload, which is exactly Correctness Property 6.
 */
const legacyEncode = (p: ContentPayload): string =>
  JSON.stringify({ v: CONTENT_PAYLOAD_VERSION, ...p });

/** A non-negative safe-integer sequence number, matching the decoder's `isSeq` contract. */
const seqArb = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER });

/**
 * Generates a CANONICAL `ContentPayload` — one for which `decode(encode(p)).payload` equals `p`
 * exactly. Optional fields are emitted only in their canonical form (e.g. `viewOnce` only when
 * `true`, attachment `name` only when a string), so a successful round-trip is a meaningful check
 * rather than an artefact of the generator.
 */
const canonicalPayloadArb: fc.Arbitrary<ContentPayload> = fc.oneof(
  fc.record({ type: fc.constant('text' as const), body: fc.string() }),
  fc.record({ type: fc.constant('text' as const), body: fc.string(), viewOnce: fc.constant(true as const) }),
  fc.record({
    type: fc.constant('reaction' as const),
    targetSeq: seqArb,
    targetOutbound: fc.boolean(),
    emoji: fc.string({ minLength: 1 }),
  }),
  fc.record({
    type: fc.constant('edit' as const),
    targetSeq: seqArb,
    targetOutbound: fc.boolean(),
    body: fc.string(),
  }),
  fc.record({ type: fc.constant('delete' as const), targetSeq: seqArb, targetOutbound: fc.boolean() }),
  fc.record({ type: fc.constant('timer' as const), ttlMs: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }) }),
  fc.record(
    {
      type: fc.constant('attachment' as const),
      blobId: fc.string({ minLength: 1 }),
      key: fc.string({ minLength: 1 }),
      iv: fc.string({ minLength: 1 }),
      mediaType: fc.string({ minLength: 1 }),
      size: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
      name: fc.string({ minLength: 1 }),
    },
    { requiredKeys: ['type', 'blobId', 'key', 'iv', 'mediaType', 'size'] },
  ),
  fc.record({ type: fc.constant('verify-request' as const), seed: fc.string({ minLength: 1 }) }),
  fc.record({ type: fc.constant('verify-response' as const), code: fc.string({ minLength: 1 }) }),
  fc.record({ type: fc.constant('verify-result' as const), ok: fc.boolean() }),
  fc.record({ type: fc.constant('duress-alert' as const), peerUid: fc.string({ minLength: 1 }) }),
) as fc.Arbitrary<ContentPayload>;

/** A routable threadId: a non-empty string of 1..255 UTF-16 code units. */
const threadIdArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 255 })
  .filter((s) => s.length >= 1 && s.length <= 255);

test('Property 6: encode with no threadId is byte-for-byte identical to the legacy encoder', () => {
  // Feature: shadow-chat, Correctness Property 6 (surface backward-compatibility, byte-for-byte).
  fc.assert(
    fc.property(canonicalPayloadArb, (payload) => {
      assert.equal(encodeContentPayload(payload), legacyEncode(payload));
    }),
    { numRuns: 200 },
  );
});

test('Property 7: decode recovers payload + threadId for arbitrary non-empty ids', () => {
  // Feature: shadow-chat, Correctness Property 7 (threadId round-trip).
  fc.assert(
    fc.property(canonicalPayloadArb, threadIdArb, (payload, threadId) => {
      const decoded = decodeContentPayload(encodeContentPayload(payload, threadId));
      assert.deepEqual(decoded.payload, payload);
      assert.equal(decoded.threadId, threadId);
    }),
    { numRuns: 200 },
  );
});

test('Property 7: a no-threadId round-trip recovers the payload with threadId absent', () => {
  // Feature: shadow-chat, Correctness Property 7 (surface fallback within the round-trip).
  fc.assert(
    fc.property(canonicalPayloadArb, (payload) => {
      const decoded = decodeContentPayload(encodeContentPayload(payload));
      assert.deepEqual(decoded.payload, payload);
      assert.equal(decoded.threadId, undefined);
    }),
    { numRuns: 200 },
  );
});

test('Property 7: decode is total — never throws for arbitrary/fuzzed strings', () => {
  // Feature: shadow-chat, Correctness Property 7 (decode totality, Req 6.6/6.7, 10.2).
  // Cover empty strings, very long strings, full-unicode noise, and envelope-shaped JSON with
  // arbitrary threadId values, all of which must return a defined result and never throw.
  const fuzzedInput = fc.oneof(
    fc.string(),
    fc.string({ maxLength: 5000 }),
    fc.fullUnicodeString(),
    fc.constant(''),
    fc.constant('x'.repeat(100_000)),
    fc.json(),
    fc
      .record({ threadId: fc.anything() }, { requiredKeys: [] })
      .map((extra) => JSON.stringify({ v: CONTENT_PAYLOAD_VERSION, type: 'text', body: 'b', ...extra })),
  );
  fc.assert(
    fc.property(fuzzedInput, (raw) => {
      const decoded = decodeContentPayload(raw);
      // A defined result with a payload is always returned; threadId is either absent or a
      // non-empty 1..255-char string.
      assert.ok(decoded && typeof decoded === 'object');
      assert.ok(decoded.payload && typeof decoded.payload.type === 'string');
      if (decoded.threadId !== undefined) {
        assert.equal(typeof decoded.threadId, 'string');
        assert.ok(decoded.threadId.length >= 1 && decoded.threadId.length <= 255);
      }
    }),
    { numRuns: 300 },
  );
});
