import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import type { CiphertextBody, EnvelopeRouting } from '@chat-app/types';

import { createEnvelopeCodec } from './envelope-codec';

/**
 * Property-based tests for the `EnvelopeCodec` (fast-check, >= 100 cases each).
 * The crypto package runs `node --test`, so fast-check is driven inside node:test
 * `test()` blocks rather than Jest, but the property semantics are identical.
 */

const routingArb: fc.Arbitrary<EnvelopeRouting> = fc.record({
  senderUid: fc.string(),
  recipientUid: fc.string(),
  senderDeviceId: fc.string(),
  seq: fc.nat(),
});

const bodyArb: fc.Arbitrary<CiphertextBody> = fc.record({
  type: fc.constantFrom<1 | 3>(1, 3),
  ciphertext: fc.base64String(),
});

const codec = createEnvelopeCodec();

test('Property 2: envelope codec round-trip', () => {
  // Feature: phase1-client-messaging, Property 2: Envelope codec round-trip
  fc.assert(
    fc.property(routingArb, bodyArb, (routing, body) => {
      const decoded = codec.decode(codec.encode(routing, body));
      assert.deepEqual(decoded.routing, routing);
      assert.deepEqual(decoded.body, body);
    }),
    { numRuns: 200 },
  );
});

test('Property 3: no plaintext on the wire', () => {
  // Feature: phase1-client-messaging, Property 3: No plaintext on the wire
  fc.assert(
    fc.property(routingArb, bodyArb, fc.string(), (routing, body, plaintext) => {
      // A non-base64 sentinel can never be a substring of the base64 ciphertext, so its
      // absence proves the codec did not smuggle the plaintext onto the wire.
      const sentinel = `${plaintext}!PLAINTEXT!`;
      // Attempt to smuggle plaintext-bearing fields onto both halves of the input.
      const taintedMeta = { ...routing, plaintext: sentinel } as unknown as EnvelopeRouting;
      const taintedBody = { ...body, plaintext: sentinel } as unknown as CiphertextBody;

      const envelope = codec.encode(taintedMeta, taintedBody);
      const serialized = JSON.stringify(envelope);

      // The envelope carries exactly the six known fields — no plaintext field exists.
      assert.deepEqual(Object.keys(envelope).sort(), [
        'ciphertext',
        'recipientUid',
        'senderDeviceId',
        'senderUid',
        'seq',
        'type',
      ]);
      assert.ok(!('plaintext' in envelope));
      assert.ok(!serialized.includes(sentinel));
    }),
    { numRuns: 200 },
  );
});
