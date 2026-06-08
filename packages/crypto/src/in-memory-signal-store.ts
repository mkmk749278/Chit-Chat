/**
 * `@chat-app/crypto` — in-memory {@link SignalProtocolStore} (Phase 1).
 *
 * A pure-JS, dependency-free implementation of the libsignal-facing store surface. It is
 * the reference store used by the end-to-end engine test and is suitable for the web
 * client (process-memory, wiped on session end). The mobile client backs the SAME port
 * with the SQLCipher `KeyStore` instead.
 *
 * It holds only opaque byte records (serialized libsignal objects); it performs no
 * cryptography itself — all crypto stays inside the {@link LibsignalEngine}.
 */

import type { SignalAddress, SignalProtocolStore } from './ports';

/** Seed material for a freshly-created store: the device's identity + its own prekeys. */
export interface InMemorySignalStoreSeed {
  /** The device's libsignal identity key pair (serialized public + PRIVATE halves). */
  identityKeyPair: { publicKey: Uint8Array; privateKey: Uint8Array };
  /** The device's libsignal registration id (>= 1). */
  registrationId: number;
  /** Serialized one-time `PreKeyRecord`s this device published (recipient side). */
  preKeys?: ReadonlyArray<{ keyId: number; record: Uint8Array }>;
  /** Serialized `SignedPreKeyRecord`s this device published (recipient side). */
  signedPreKeys?: ReadonlyArray<{ keyId: number; record: Uint8Array }>;
}

/** Stable map key for a remote address (Phase 1 is single-device per user). */
function addressKey(address: SignalAddress): string {
  return `${address.uid}:${address.deviceId}`;
}

/** Constant-time-ish byte comparison (length + content); inputs are public key bytes. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/**
 * Build an in-memory {@link SignalProtocolStore} seeded with the device's identity and
 * (for a recipient) its published prekeys. Sessions and remote identities accumulate as
 * messages are exchanged. Trust is TOFU (trust-on-first-use): a remote key is trusted if
 * unseen or unchanged; a changed key is reported untrusted (the design defers the
 * verification UI).
 */
export function createInMemorySignalProtocolStore(
  seed: InMemorySignalStoreSeed,
): SignalProtocolStore {
  const sessions = new Map<string, Uint8Array>();
  const identities = new Map<string, Uint8Array>();
  const preKeys = new Map<number, Uint8Array>();
  const signedPreKeys = new Map<number, Uint8Array>();

  for (const pk of seed.preKeys ?? []) {
    preKeys.set(pk.keyId, pk.record);
  }
  for (const sk of seed.signedPreKeys ?? []) {
    signedPreKeys.set(sk.keyId, sk.record);
  }

  return {
    async getIdentityKeyPair() {
      return seed.identityKeyPair;
    },
    async getLocalRegistrationId() {
      return seed.registrationId;
    },
    async loadSession(address) {
      return sessions.get(addressKey(address)) ?? null;
    },
    async storeSession(address, record) {
      sessions.set(addressKey(address), record);
    },
    async loadPreKey(keyId) {
      return preKeys.get(keyId) ?? null;
    },
    async removePreKey(keyId) {
      preKeys.delete(keyId);
    },
    async loadSignedPreKey(keyId) {
      return signedPreKeys.get(keyId) ?? null;
    },
    async saveIdentity(address, identityKey) {
      const key = addressKey(address);
      const existing = identities.get(key);
      const changed = existing !== undefined && !bytesEqual(existing, identityKey);
      identities.set(key, identityKey);
      return changed;
    },
    async isTrustedIdentity(address, identityKey) {
      const existing = identities.get(addressKey(address));
      return existing === undefined || bytesEqual(existing, identityKey);
    },
    async loadIdentityKey(address) {
      return identities.get(addressKey(address)) ?? null;
    },
  };
}
