import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as Signal from '@signalapp/libsignal-client';

import type { ClaimedPreKeyBundle } from '@chat-app/types';

import { createEnvelopeCodec } from './envelope-codec';
import { createInMemorySignalProtocolStore } from './in-memory-signal-store';
import { createLibsignalEngine } from './libsignal-engine.node';
import { createSessionManager } from './session-manager';
import type { SignalProtocolStore } from './ports';

/**
 * End-to-end engine proof (task 6.9 engine core; Requirements 5.1, 5.2, 5.3, 5.4, 5.7).
 *
 * Wires the REAL `@signalapp/libsignal-client`-backed {@link createLibsignalEngine} into
 * the shared {@link createSessionManager} over the in-memory {@link SignalProtocolStore},
 * and exchanges messages through the shared `EnvelopeCodec` wire frame — proving actual
 * end-to-end encryption round-trips through our own abstractions (not just the raw
 * library), the wire envelope never carries plaintext, and the one-time prekey is
 * consumed exactly once.
 */

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const codec = createEnvelopeCodec();

const PREKEY_ID = 31337;
const SIGNED_PREKEY_ID = 22;

interface RecipientFixture {
  store: SignalProtocolStore;
  bundle: ClaimedPreKeyBundle;
}

/** Generate a recipient's identity + published prekeys, seeding an in-memory store. */
function newRecipient(uid: string, deviceId: string, registrationId: number): RecipientFixture {
  const identity = Signal.IdentityKeyPair.generate();

  const preKeyPair = Signal.PrivateKey.generate();
  const preKeyRecord = Signal.PreKeyRecord.new(PREKEY_ID, preKeyPair.getPublicKey(), preKeyPair);

  const signedPair = Signal.PrivateKey.generate();
  const signature = identity.privateKey.sign(signedPair.getPublicKey().serialize());
  const signedRecord = Signal.SignedPreKeyRecord.new(
    SIGNED_PREKEY_ID,
    0,
    signedPair.getPublicKey(),
    signedPair,
    signature,
  );

  const store = createInMemorySignalProtocolStore({
    identityKeyPair: {
      publicKey: new Uint8Array(identity.publicKey.serialize()),
      privateKey: new Uint8Array(identity.privateKey.serialize()),
    },
    registrationId,
    preKeys: [{ keyId: PREKEY_ID, record: new Uint8Array(preKeyRecord.serialize()) }],
    signedPreKeys: [{ keyId: SIGNED_PREKEY_ID, record: new Uint8Array(signedRecord.serialize()) }],
  });

  const bundle: ClaimedPreKeyBundle = {
    deviceId,
    registrationId,
    identityKey: b64(new Uint8Array(identity.publicKey.serialize())),
    signedPreKey: {
      keyId: SIGNED_PREKEY_ID,
      publicKey: b64(new Uint8Array(signedPair.getPublicKey().serialize())),
      signature: b64(new Uint8Array(signature)),
    },
    oneTimePreKey: {
      keyId: PREKEY_ID,
      publicKey: b64(new Uint8Array(preKeyPair.getPublicKey().serialize())),
    },
  };

  return { store, bundle };
}

/** Generate a sender's identity-only in-memory store (no published prekeys needed). */
function newSenderStore(registrationId: number): SignalProtocolStore {
  const identity = Signal.IdentityKeyPair.generate();
  return createInMemorySignalProtocolStore({
    identityKeyPair: {
      publicKey: new Uint8Array(identity.publicKey.serialize()),
      privateKey: new Uint8Array(identity.privateKey.serialize()),
    },
    registrationId,
  });
}

test('E2E: a real encrypted message round-trips through SessionManager + envelope (5.1, 5.2, 5.4)', async () => {
  const bob = newRecipient('bob-uid', 'bob-device-1', 1234);
  const aliceStore = newSenderStore(5678);

  const alice = createSessionManager(aliceStore, createLibsignalEngine());
  const bobSession = createSessionManager(bob.store, createLibsignalEngine());

  // Alice establishes a session from Bob's claimed bundle, then encrypts.
  await alice.establishSession('bob-uid', bob.bundle);
  const secret = 'attack at dawn 🔐';
  const body = await alice.encrypt('bob-uid', secret);
  assert.equal(body.type, 3, 'first message is a PreKeySignalMessage (type 3)');

  const envelope = codec.encode(
    { senderUid: 'alice-uid', recipientUid: 'bob-uid', senderDeviceId: 'alice-device-1', seq: 1 },
    body,
  );

  // The wire frame must carry NO plaintext (Requirement 5.7 / 8.2).
  assert.ok(!JSON.stringify(envelope).includes('attack'), 'plaintext must not appear on the wire');

  // Bob decrypts the envelope back to the original plaintext.
  const decrypted = await bobSession.decrypt(envelope);
  assert.equal(decrypted, secret);
});

test('E2E: bidirectional exchange ratchets to a whisper over persisted state (5.4, 5.8)', async () => {
  const bob = newRecipient('bob-uid', 'bob-device-1', 1234);
  const aliceStore = newSenderStore(5678);
  const alice = createSessionManager(aliceStore, createLibsignalEngine());
  const bobSession = createSessionManager(bob.store, createLibsignalEngine());

  await alice.establishSession('bob-uid', bob.bundle);

  // Alice → Bob (prekey message).
  const e1 = codec.encode(
    { senderUid: 'alice-uid', recipientUid: 'bob-uid', senderDeviceId: 'alice-device-1', seq: 1 },
    await alice.encrypt('bob-uid', 'm1'),
  );
  assert.equal(await bobSession.decrypt(e1), 'm1');

  // Bob → Alice reply (Bob learned Alice's address from the inbound envelope).
  const r1 = codec.encode(
    { senderUid: 'bob-uid', recipientUid: 'alice-uid', senderDeviceId: 'bob-device-1', seq: 1 },
    await bobSession.encrypt('alice-uid', 'reply-1'),
  );
  assert.equal(await alice.decrypt(r1), 'reply-1');

  // Alice → Bob again — now a SignalMessage (whisper, type 1), proving the live session.
  const body2 = await alice.encrypt('bob-uid', 'm2 ✅');
  assert.equal(body2.type, 1, 'subsequent message is a SignalMessage (whisper)');
  const e2 = codec.encode(
    { senderUid: 'alice-uid', recipientUid: 'bob-uid', senderDeviceId: 'alice-device-1', seq: 2 },
    body2,
  );
  assert.equal(await bobSession.decrypt(e2), 'm2 ✅');
});

test('E2E: the one-time prekey is consumed exactly once on first inbound (5.1)', async () => {
  const bob = newRecipient('bob-uid', 'bob-device-1', 1234);
  const aliceStore = newSenderStore(5678);
  const alice = createSessionManager(aliceStore, createLibsignalEngine());
  const bobSession = createSessionManager(bob.store, createLibsignalEngine());

  assert.notEqual(await bob.store.loadPreKey(PREKEY_ID), null, 'prekey present before use');

  await alice.establishSession('bob-uid', bob.bundle);
  const e1 = codec.encode(
    { senderUid: 'alice-uid', recipientUid: 'bob-uid', senderDeviceId: 'alice-device-1', seq: 1 },
    await alice.encrypt('bob-uid', 'consume my prekey'),
  );
  await bobSession.decrypt(e1);

  assert.equal(await bob.store.loadPreKey(PREKEY_ID), null, 'one-time prekey removed after first inbound');
});
