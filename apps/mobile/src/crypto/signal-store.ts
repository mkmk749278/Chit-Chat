/**
 * `apps/mobile` — build a {@link SignalProtocolStore} from the device's {@link IdentityRecord}.
 *
 * The {@link SessionManager} + pure-TS engine drive a {@link SignalProtocolStore} (its own
 * identity key, registration id, prekeys, and accumulating session/identity state). Our
 * {@link IdentityManager} persists the device's identity as an {@link IdentityRecord} via the
 * {@link KeyStore}; this adapter projects that record into the store the engine expects.
 *
 * The device's own one-time / signed prekeys are encoded with {@link encodePreKeyRecord}
 * (the pure-TS engine's keypair-blob format) so the engine can load them back as key pairs
 * when decrypting an inbound prekey message. Sessions and remote identities accumulate in
 * the returned store (in process memory for v1, alongside the in-memory KeyStore).
 */

import {
  createInMemorySignalProtocolStore,
  encodePreKeyRecord,
  type IdentityRecord,
  type SignalProtocolStore,
} from '@chat-app/crypto';

/** Project a persisted {@link IdentityRecord} into a {@link SignalProtocolStore}. */
export function signalStoreFromIdentity(record: IdentityRecord): SignalProtocolStore {
  return createInMemorySignalProtocolStore({
    identityKeyPair: {
      publicKey: record.identityKeyPublic,
      privateKey: record.identityKeyPrivate,
    },
    registrationId: record.registrationId,
    preKeys: record.oneTimePreKeys.map((key) => ({
      keyId: key.keyId,
      record: encodePreKeyRecord(key.publicKey, key.privateKey),
    })),
    signedPreKeys: [
      {
        keyId: record.signedPreKey.keyId,
        record: encodePreKeyRecord(record.signedPreKey.publicKey, record.signedPreKey.privateKey),
      },
    ],
  });
}
