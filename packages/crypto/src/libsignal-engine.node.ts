/**
 * `@chat-app/crypto` — real {@link LibsignalEngine} backed by `@signalapp/libsignal-client`.
 *
 * This binds the thin engine port (see `session-manager.ts`) to the native libsignal
 * library, bridging our byte-oriented {@link SignalProtocolStore} to libsignal's own
 * store interfaces. It implements the exact behavior documented in
 * `createUnboundLibsignalEngine`'s TODO: build a session from a claimed bundle, encrypt
 * with `signalEncrypt`, and decrypt prekey/whisper messages — consuming the one-time
 * prekey on first inbound.
 *
 * Kept in a `.node` module and DELIBERATELY NOT exported from the package index: it
 * statically imports the native library, which the React Native (Metro) and web bundlers
 * cannot include. Node consumers (the backend, tests, and tooling) import it directly;
 * the React-Native runtime supplies its own binding of this same port.
 *
 * Phase 1 models a single device per user, so the remote libsignal `ProtocolAddress`
 * uses a fixed device id; the bridge keys all on-device storage by our full
 * {@link SignalAddress} (uid + server deviceId) via closure, so it stays consistent with
 * `DefaultSessionManager`.
 */

import * as Signal from '@signalapp/libsignal-client';

import type { ClaimedPreKeyBundle } from '@chat-app/types';

import type { SignalAddress, SignalProtocolStore } from './ports';
import type { EncryptedMessage, LibsignalEngine } from './session-manager';

/** Fixed libsignal device id for the single-device-per-user Phase 1 model. */
const REMOTE_DEVICE_ID = 1;

const toBuffer = (bytes: Uint8Array): Buffer => Buffer.from(bytes);
const toBytes = (buffer: Buffer): Uint8Array => new Uint8Array(buffer);
const base64ToBuffer = (value: string): Buffer => Buffer.from(value, 'base64');

/** Map our {@link SignalAddress} to a libsignal {@link Signal.ProtocolAddress}. */
function protocolAddress(address: SignalAddress): Signal.ProtocolAddress {
  return Signal.ProtocolAddress.new(address.uid, REMOTE_DEVICE_ID);
}

// ---------------------------------------------------------------------------
// Store bridges. Each instance is per-engine-call and closes over the local
// SignalProtocolStore plus the remote SignalAddress, so libsignal's address-keyed
// reads/writes resolve to our full (uid + deviceId) key regardless of the numeric
// libsignal device id.
// ---------------------------------------------------------------------------

class SessionStoreBridge extends Signal.SessionStore {
  constructor(
    private readonly store: SignalProtocolStore,
    private readonly remote: SignalAddress,
  ) {
    super();
  }
  async saveSession(_name: Signal.ProtocolAddress, record: Signal.SessionRecord): Promise<void> {
    await this.store.storeSession(this.remote, toBytes(record.serialize()));
  }
  async getSession(_name: Signal.ProtocolAddress): Promise<Signal.SessionRecord | null> {
    const bytes = await this.store.loadSession(this.remote);
    return bytes !== null ? Signal.SessionRecord.deserialize(toBuffer(bytes)) : null;
  }
  async getExistingSessions(addresses: Signal.ProtocolAddress[]): Promise<Signal.SessionRecord[]> {
    const bytes = await this.store.loadSession(this.remote);
    if (bytes === null) {
      throw new Error('no existing session for requested address');
    }
    const record = Signal.SessionRecord.deserialize(toBuffer(bytes));
    return addresses.map(() => record);
  }
}

class IdentityStoreBridge extends Signal.IdentityKeyStore {
  constructor(
    private readonly store: SignalProtocolStore,
    private readonly remote: SignalAddress,
  ) {
    super();
  }
  async getIdentityKey(): Promise<Signal.PrivateKey> {
    const pair = await this.store.getIdentityKeyPair();
    return Signal.PrivateKey.deserialize(toBuffer(pair.privateKey));
  }
  async getLocalRegistrationId(): Promise<number> {
    return this.store.getLocalRegistrationId();
  }
  async saveIdentity(_name: Signal.ProtocolAddress, key: Signal.PublicKey): Promise<boolean> {
    return this.store.saveIdentity(this.remote, toBytes(key.serialize()));
  }
  async isTrustedIdentity(_name: Signal.ProtocolAddress, key: Signal.PublicKey): Promise<boolean> {
    return this.store.isTrustedIdentity(this.remote, toBytes(key.serialize()));
  }
  async getIdentity(_name: Signal.ProtocolAddress): Promise<Signal.PublicKey | null> {
    const bytes = await this.store.loadIdentityKey(this.remote);
    return bytes !== null ? Signal.PublicKey.deserialize(toBuffer(bytes)) : null;
  }
}

class PreKeyStoreBridge extends Signal.PreKeyStore {
  constructor(private readonly store: SignalProtocolStore) {
    super();
  }
  async savePreKey(_id: number, _record: Signal.PreKeyRecord): Promise<void> {
    // Recipient one-time prekeys are pre-populated by the Identity_Manager/KeyStore;
    // libsignal never asks us to save new ones during a 1:1 exchange.
  }
  async getPreKey(id: number): Promise<Signal.PreKeyRecord> {
    const bytes = await this.store.loadPreKey(id);
    if (bytes === null) {
      throw new Error(`no one-time prekey ${id}`);
    }
    return Signal.PreKeyRecord.deserialize(toBuffer(bytes));
  }
  async removePreKey(id: number): Promise<void> {
    await this.store.removePreKey(id);
  }
}

class SignedPreKeyStoreBridge extends Signal.SignedPreKeyStore {
  constructor(private readonly store: SignalProtocolStore) {
    super();
  }
  async saveSignedPreKey(_id: number, _record: Signal.SignedPreKeyRecord): Promise<void> {
    // Signed prekeys are managed by the Identity_Manager/KeyStore, not libsignal here.
  }
  async getSignedPreKey(id: number): Promise<Signal.SignedPreKeyRecord> {
    const bytes = await this.store.loadSignedPreKey(id);
    if (bytes === null) {
      throw new Error(`no signed prekey ${id}`);
    }
    return Signal.SignedPreKeyRecord.deserialize(toBuffer(bytes));
  }
}

class KyberPreKeyStoreBridge extends Signal.KyberPreKeyStore {
  async saveKyberPreKey(_id: number, _record: Signal.KyberPreKeyRecord): Promise<void> {
    // Phase 1 uses classic X3DH bundles; Kyber/PQXDH is out of scope.
  }
  async getKyberPreKey(id: number): Promise<Signal.KyberPreKeyRecord> {
    throw new Error(`kyber prekey ${id} requested but PQXDH is not used in Phase 1`);
  }
  async markKyberPreKeyUsed(_id: number): Promise<void> {
    // No-op: no Kyber prekeys are present to consume.
  }
}

/** Build a libsignal {@link Signal.PreKeyBundle} from a claimed (base64) bundle. */
function buildPreKeyBundle(bundle: ClaimedPreKeyBundle): Signal.PreKeyBundle {
  const identityKey = Signal.PublicKey.deserialize(base64ToBuffer(bundle.identityKey));
  const signedPublic = Signal.PublicKey.deserialize(base64ToBuffer(bundle.signedPreKey.publicKey));
  const signedSignature = base64ToBuffer(bundle.signedPreKey.signature);
  const otk = bundle.oneTimePreKey;

  if (otk !== null) {
    return Signal.PreKeyBundle.new(
      bundle.registrationId,
      REMOTE_DEVICE_ID,
      otk.keyId,
      Signal.PublicKey.deserialize(base64ToBuffer(otk.publicKey)),
      bundle.signedPreKey.keyId,
      signedPublic,
      signedSignature,
      identityKey,
    );
  }
  // No one-time prekey available: build a bundle without one (still valid X3DH).
  return Signal.PreKeyBundle.new(
    bundle.registrationId,
    REMOTE_DEVICE_ID,
    null,
    null,
    bundle.signedPreKey.keyId,
    signedPublic,
    signedSignature,
    identityKey,
  );
}

/**
 * Create the real {@link LibsignalEngine}. All session/identity/prekey state flows through
 * the supplied {@link SignalProtocolStore}; private key material never leaves it.
 */
export function createLibsignalEngine(): LibsignalEngine {
  return {
    async processPreKeyBundle(address, bundle, store): Promise<void> {
      await Signal.processPreKeyBundle(
        buildPreKeyBundle(bundle),
        protocolAddress(address),
        new SessionStoreBridge(store, address),
        new IdentityStoreBridge(store, address),
      );
    },

    async encrypt(address, plaintext, store): Promise<EncryptedMessage> {
      const ciphertext = await Signal.signalEncrypt(
        toBuffer(plaintext),
        protocolAddress(address),
        new SessionStoreBridge(store, address),
        new IdentityStoreBridge(store, address),
      );
      // libsignal: 3 = PreKeySignalMessage, 2 = (whisper) SignalMessage. The wire frame
      // uses 3 = PreKeySignalMessage, 1 = SignalMessage (design Data Models).
      const type: 1 | 3 = ciphertext.type() === 3 ? 3 : 1;
      return { type, ciphertext: toBytes(ciphertext.serialize()) };
    },

    async decrypt(address, message, store): Promise<Uint8Array> {
      const addr = protocolAddress(address);
      const sessions = new SessionStoreBridge(store, address);
      const identity = new IdentityStoreBridge(store, address);

      if (message.type === 3) {
        const prekeyMessage = Signal.PreKeySignalMessage.deserialize(toBuffer(message.ciphertext));
        const plaintext = await Signal.signalDecryptPreKey(
          prekeyMessage,
          addr,
          sessions,
          identity,
          new PreKeyStoreBridge(store),
          new SignedPreKeyStoreBridge(store),
          new KyberPreKeyStoreBridge(),
        );
        return toBytes(plaintext);
      }

      const whisper = Signal.SignalMessage.deserialize(toBuffer(message.ciphertext));
      const plaintext = await Signal.signalDecrypt(whisper, addr, sessions, identity);
      return toBytes(plaintext);
    },
  };
}
