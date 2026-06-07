import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import type { CiphertextEnvelope } from '@chat-app/types';

import type { SignalProtocolStore } from './ports';
import {
  createSessionManager,
  type EncryptedMessage,
  type LibsignalEngine,
} from './session-manager';

/** Engine whose decrypt always fails, modelling corrupt ciphertext / bad key state. */
function failingEngine(): LibsignalEngine {
  return {
    async processPreKeyBundle(): Promise<void> {},
    async encrypt(): Promise<EncryptedMessage> {
      return { type: 1, ciphertext: new Uint8Array() };
    },
    async decrypt(): Promise<Uint8Array> {
      throw new Error('libsignal: decryption failed');
    },
  };
}

const store = {} as unknown as SignalProtocolStore;

const envelopeArb: fc.Arbitrary<CiphertextEnvelope> = fc.record({
  senderUid: fc.string({ minLength: 1 }),
  recipientUid: fc.string({ minLength: 1 }),
  senderDeviceId: fc.string({ minLength: 1 }),
  seq: fc.nat(),
  type: fc.constantFrom<1 | 3>(1, 3),
  ciphertext: fc.base64String(),
});

test('Property 15: a failed decrypt rejects and yields no plaintext', async () => {
  // Feature: phase1-client-messaging, Property 15: Decrypt failure yields no plaintext
  await fc.assert(
    fc.asyncProperty(envelopeArb, async (envelope) => {
      const sessions = createSessionManager(store, failingEngine());
      let plaintext: string | undefined;
      let rejected = false;
      try {
        plaintext = await sessions.decrypt(envelope);
      } catch {
        rejected = true;
      }
      // The caller (Messaging) maps this rejection to a delivery-error with no plaintext.
      assert.equal(rejected, true);
      assert.equal(plaintext, undefined);
    }),
    { numRuns: 150 },
  );
});
