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
 * Property tests for the Shadow Chat Invites control payloads (design "Component B": shadow-invite /
 * shadow-accept / shadow-decline / shadow-revoke).
 *
 * Feature: shadow-chat-invites. Validates design Correctness Property 10 (total inbound decode): for
 * an arbitrary string as decrypted plaintext, `decodeContentPayload` returns without throwing, and a
 * malformed `shadow-invite` (deliberately non-32-byte key) decodes to `unsupported` (no thread, no
 * crash). Also covers round-trip equivalence for arbitrary VALID shadow control payloads
 * (Req 9, 11.3, 12). Each property runs >=100 randomised iterations and reports the counterexample
 * fast-check produces on failure.
 */

/** A canonical base64 string that decodes to exactly 32 bytes (the valid shadow thread-key shape). */
const key32Arb: fc.Arbitrary<string> = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((bytes) => Buffer.from(bytes).toString('base64'));

/** A non-empty inviteId; any non-empty string is accepted by the codec. */
const inviteIdArb: fc.Arbitrary<string> = fc.string({ minLength: 1 });

/** A routable threadId reference: a non-empty string of 1..255 UTF-16 code units (the codec bound). */
const threadIdArb: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 255 });

/**
 * Generates a CANONICAL shadow control `ContentPayload` — one for which `decode(encode(p)).payload`
 * equals `p` exactly. The `shadow-invite` `label` is emitted only as a string (its canonical form),
 * so a successful round-trip is a meaningful check rather than an artefact of the generator.
 */
const shadowControlArb: fc.Arbitrary<ContentPayload> = fc.oneof(
  fc.record(
    {
      type: fc.constant('shadow-invite' as const),
      inviteId: inviteIdArb,
      key: key32Arb,
      label: fc.string(),
    },
    { requiredKeys: ['type', 'inviteId', 'key'] },
  ),
  fc.record({ type: fc.constant('shadow-accept' as const), inviteId: inviteIdArb }),
  fc.record({ type: fc.constant('shadow-decline' as const), inviteId: inviteIdArb }),
  fc.record({ type: fc.constant('shadow-revoke' as const), inviteId: inviteIdArb, threadId: threadIdArb }),
) as fc.Arbitrary<ContentPayload>;

test('Property 10: decode is total — never throws for arbitrary plaintext strings', () => {
  // Feature: shadow-chat-invites, design Correctness Property 10 (total inbound decode).
  fc.assert(
    fc.property(fc.oneof(fc.string(), fc.fullUnicodeString(), fc.json()), (raw) => {
      const decoded = decodeContentPayload(raw);
      assert.ok(decoded && typeof decoded === 'object');
      assert.ok(decoded.payload && typeof decoded.payload.type === 'string');
    }),
    { numRuns: 200 },
  );
});

test('Property 10: a shadow-invite with a deliberately non-32-byte key decodes to unsupported', () => {
  // Feature: shadow-chat-invites, design Correctness Property 10 (malformed invite ⇒ unsupported).
  // Any byte length other than 32 (encoded as canonical base64) must be rejected.
  const nonThirtyTwoLen = fc.integer({ min: 0, max: 96 }).filter((n) => n !== 32);
  fc.assert(
    fc.property(inviteIdArb, nonThirtyTwoLen, (inviteId, byteLen) => {
      const key = Buffer.alloc(byteLen, 7).toString('base64');
      const raw = JSON.stringify({ v: CONTENT_PAYLOAD_VERSION, type: 'shadow-invite', inviteId, key });
      assert.deepEqual(decodeContentPayload(raw).payload, { type: 'unsupported' });
    }),
    { numRuns: 200 },
  );
});

test('Property 10: a shadow-invite with a non-base64 key decodes to unsupported', () => {
  // Feature: shadow-chat-invites — strict base64 (no lenient platform decode lets garbage through).
  const nonBase64 = fc
    .string({ minLength: 1 })
    .filter((s) => !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0);
  fc.assert(
    fc.property(inviteIdArb, nonBase64, (inviteId, key) => {
      const raw = JSON.stringify({ v: CONTENT_PAYLOAD_VERSION, type: 'shadow-invite', inviteId, key });
      assert.deepEqual(decodeContentPayload(raw).payload, { type: 'unsupported' });
    }),
    { numRuns: 200 },
  );
});

test('Property 10: round-trip equivalence for arbitrary valid shadow control payloads', () => {
  // Feature: shadow-chat-invites — decode(encode(p)).payload === p for every valid shadow control.
  fc.assert(
    fc.property(shadowControlArb, (payload) => {
      const decoded = decodeContentPayload(encodeContentPayload(payload));
      assert.deepEqual(decoded.payload, payload);
      assert.equal(decoded.threadId, undefined);
    }),
    { numRuns: 200 },
  );
});

test('Property 10: valid shadow controls also round-trip when carried with a routing threadId', () => {
  // Feature: shadow-chat-invites — the optional envelope threadId is orthogonal to the payload shape.
  fc.assert(
    fc.property(shadowControlArb, threadIdArb, (payload, threadId) => {
      const decoded = decodeContentPayload(encodeContentPayload(payload, threadId));
      assert.deepEqual(decoded.payload, payload);
      assert.equal(decoded.threadId, threadId);
    }),
    { numRuns: 200 },
  );
});
