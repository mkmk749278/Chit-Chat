import fc from 'fast-check';
import type { AuthContext, CiphertextEnvelope } from '@chat-app/types';

import { InProcessSocketRegistry } from './local-socket-registry';
import { MessageRelayService } from './message-relay.service';

/**
 * Property test for {@link MessageRelayService.relay} (task 4.6, Property 23,
 * Requirements 5.7, 8.2): the relay routes an envelope IF AND ONLY IF the envelope's
 * declared `senderUid` equals the authenticated connection's uid, and it treats the
 * ciphertext body as opaque on every path (it is never decoded).
 */

function buildService(presence: Record<string, string> = { 'conn-1': 'node-a' }) {
  const publish = jest.fn().mockResolvedValue(1);
  const lookup = jest.fn().mockResolvedValue(presence);
  const publisher = { publish } as unknown as ConstructorParameters<typeof MessageRelayService>[0];
  const presenceRegistry = {
    lookup,
  } as unknown as ConstructorParameters<typeof MessageRelayService>[1];
  const offlineQueue = {
    enqueue: jest.fn().mockResolvedValue(undefined),
  } as unknown as ConstructorParameters<typeof MessageRelayService>[3];
  const service = new MessageRelayService(
    publisher,
    presenceRegistry,
    new InProcessSocketRegistry(),
    offlineQueue,
  );
  return { service, publish };
}

const nonEmpty = fc.string({ minLength: 1, maxLength: 24 });

const envelopeArb = (senderUid: string): fc.Arbitrary<CiphertextEnvelope> =>
  fc.record({
    recipientUid: nonEmpty,
    senderDeviceId: nonEmpty,
    seq: fc.nat(),
    type: fc.constantFrom<1 | 3>(1, 3),
    // Non-empty base64 so the envelope is structurally valid (not 'malformed').
    ciphertext: fc.base64String({ minLength: 4 }).filter((s) => s.length > 0),
  }).map((rest) => ({ senderUid, ...rest }));

test('Property 23: relay routes iff envelope.senderUid === authenticated uid', async () => {
  // Feature: phase1-client-messaging, Property 23: Relay binds sender to the authenticated connection
  await fc.assert(
    fc.asyncProperty(nonEmpty, nonEmpty, async (authUid, declaredSender) => {
      const { service, publish } = buildService();
      const auth: AuthContext = { uid: authUid, tokenExp: 9_999_999_999 };
      const envelope = fc.sample(envelopeArb(declaredSender), 1)[0]!;

      const outcome = await service.relay(auth, envelope);

      if (declaredSender === authUid) {
        // Bound sender ⇒ accepted for delivery (recipient online here ⇒ published).
        expect(outcome).toEqual({ status: 'received' });
      } else {
        // Spoofed sender ⇒ rejected and nothing published.
        expect(outcome).toEqual({ status: 'rejected', reason: 'sender-mismatch' });
        expect(publish).not.toHaveBeenCalled();
      }
    }),
    { numRuns: 200 },
  );
});
