/**
 * `@chat-app/crypto` — pure-TypeScript {@link LibsignalEngine} + {@link LibsignalKeyGen}
 * backed by `@privacyresearch/libsignal-protocol-typescript`.
 *
 * This is the SHIPPABLE runtime binding of the crypto ports for BOTH the web (browser)
 * and mobile (React Native / Hermes) clients. Unlike the Node-only
 * `libsignal-engine.node.ts` (which statically imports the native `@signalapp` addon and
 * therefore cannot be bundled by Metro or webpack), this module depends only on pure-JS
 * packages (`@privacyresearch/*`, `base64-js`), so it is safe to re-export from the
 * package index and bundle into either client.
 *
 * Runtime-binding decision: see `docs/messaging-runtime-binding.md`. The two peers in a
 * conversation MUST use the same protocol implementation family; this module is that one
 * implementation for all clients, so ciphertext is wire-compatible across web and mobile.
 *
 * Platform polyfills the host must provide BEFORE using this engine:
 *   - `globalThis.crypto.getRandomValues` and `globalThis.crypto.subtle` (WebCrypto). The
 *     browser has both natively. React Native (Hermes) has neither by default: import
 *     `react-native-get-random-values` at app entry and inject a WebCrypto `subtle`
 *     implementation via the library's `setWebCrypto(...)` (the package ships a pure-JS
 *     `msrcrypto` fallback; a JSI module such as `react-native-quick-crypto` is faster).
 *   - `Buffer` (used for base64 here, consistent with the rest of the shared core). Node
 *     and most RN setups provide it; the browser/RN entry should polyfill it if absent.
 *
 * Storage bridging: the library's own `StorageType` differs from our byte-oriented
 * {@link SignalProtocolStore} (it stores key PAIRS and string session records rather than
 * opaque serialized blobs). This module bridges the two, defining a small keypair-blob
 * encoding ({@link encodePreKeyRecord}) used both here and by the store seeding so the
 * device's own one-time / signed prekeys round-trip through `loadPreKey` / `loadSignedPreKey`.
 */

import SignalInit, {
  KeyHelper,
  SessionBuilder,
  SessionCipher,
  SignalProtocolAddress,
  type DeviceType,
  type KeyPairType,
  type StorageType,
} from '@privacyresearch/libsignal-protocol-typescript';

import type { ClaimedPreKeyBundle } from '@chat-app/types';

import type { GeneratedKeyPair, LibsignalKeyGen } from './identity-manager';
import type { SignalAddress, SignalProtocolStore } from './ports';
import type { EncryptedMessage, LibsignalEngine } from './session-manager';

/** Fixed libsignal device id for the single-device-per-user Phase 1 model (mirrors the node engine). */
const REMOTE_DEVICE_ID = 1;

// ---------------------------------------------------------------------------
// Byte / base64 / ArrayBuffer helpers.
// ---------------------------------------------------------------------------

/** View an `ArrayBuffer` as `Uint8Array`. */
const u8 = (buffer: ArrayBuffer): Uint8Array => new Uint8Array(buffer);

/** Copy a `Uint8Array` into a standalone `ArrayBuffer` (the library works in ArrayBuffers). */
const ab = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
};

/** Base64-encode raw bytes (consistent with the rest of the shared core). */
const b64encode = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/** Decode a base64 string to raw bytes. */
const b64decode = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'base64'));

/**
 * Convert a "binary string" (the library's `MessageType.body`, one char per byte) to raw
 * bytes for the wire ciphertext.
 */
const binaryStringToBytes = (value: string): Uint8Array =>
  Uint8Array.from(value, (char) => char.charCodeAt(0));

// ---------------------------------------------------------------------------
// Keypair-blob codec: how the device's OWN prekeys are stored in the
// SignalProtocolStore so this engine can load them back as key pairs.
// ---------------------------------------------------------------------------

/**
 * Encode a prekey/signed-prekey key pair into the opaque `Uint8Array` blob this engine
 * stores via the {@link SignalProtocolStore}. Used by store seeding (the in-memory web
 * store and the mobile SQLCipher-backed store) so that `loadPreKey` / `loadSignedPreKey`
 * return material this engine can decode with {@link decodeKeyPair}.
 *
 * The blob is JSON `{ pub, priv }` (base64) UTF-8 encoded — self-describing and free of
 * any native serialization, so it is portable across platforms.
 */
export function encodePreKeyRecord(publicKey: Uint8Array, privateKey: Uint8Array): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ pub: b64encode(publicKey), priv: b64encode(privateKey) }),
  );
}

/** Decode a {@link encodePreKeyRecord} blob back into the library's {@link KeyPairType}. */
function decodeKeyPair(bytes: Uint8Array): KeyPairType {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { pub: string; priv: string };
  return { pubKey: ab(b64decode(parsed.pub)), privKey: ab(b64decode(parsed.priv)) };
}

/** The library stores a session as an opaque string; persist it as UTF-8 bytes. */
const encodeSession = (record: string): Uint8Array => new TextEncoder().encode(record);
const decodeSession = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

// ---------------------------------------------------------------------------
// Standalone Ed25519 signing (for LibsignalKeyGen.signWithIdentity).
//
// The IdentityManager generates the signed-prekey key pair and signs it as two separate
// steps, so we need a standalone signature primitive. The library exposes one only via
// its default async initializer (which builds the Curve25519 wrapper); init once and cache.
// ---------------------------------------------------------------------------

let curvePromise: Promise<{
  calculateSignature: (privKey: ArrayBuffer, message: ArrayBuffer) => ArrayBuffer | Promise<ArrayBuffer>;
}> | null = null;

async function getCurve(): Promise<{
  calculateSignature: (privKey: ArrayBuffer, message: ArrayBuffer) => ArrayBuffer | Promise<ArrayBuffer>;
}> {
  curvePromise ??= SignalInit().then((signal) => signal.Curve);
  return curvePromise;
}

// ---------------------------------------------------------------------------
// SignalProtocolStore (ours) → library StorageType bridge.
//
// Each engine call constructs a bridge closed over the remote SignalAddress, so the
// library's address-keyed session/identity reads resolve to our full (uid + deviceId)
// key regardless of the numeric libsignal device id — exactly as the node engine does.
// ---------------------------------------------------------------------------

function bridgeStore(store: SignalProtocolStore, remote: SignalAddress): StorageType {
  return {
    async getIdentityKeyPair(): Promise<KeyPairType> {
      const pair = await store.getIdentityKeyPair();
      return { pubKey: ab(pair.publicKey), privKey: ab(pair.privateKey) };
    },
    async getLocalRegistrationId(): Promise<number> {
      return store.getLocalRegistrationId();
    },
    async isTrustedIdentity(_identifier: string, identityKey: ArrayBuffer): Promise<boolean> {
      return store.isTrustedIdentity(remote, u8(identityKey));
    },
    async saveIdentity(_identifier: string, identityKey: ArrayBuffer): Promise<boolean> {
      return store.saveIdentity(remote, u8(identityKey));
    },
    async loadPreKey(keyId: string | number): Promise<KeyPairType | undefined> {
      const bytes = await store.loadPreKey(Number(keyId));
      return bytes !== null ? decodeKeyPair(bytes) : undefined;
    },
    async storePreKey(): Promise<void> {
      // The device's own one-time prekeys are pre-populated by the Identity_Manager /
      // KeyStore; the library never asks us to save new ones during a 1:1 exchange.
    },
    async removePreKey(keyId: string | number): Promise<void> {
      await store.removePreKey(Number(keyId));
    },
    async storeSession(_identifier: string, record: string): Promise<void> {
      await store.storeSession(remote, encodeSession(record));
    },
    async loadSession(_identifier: string): Promise<string | undefined> {
      const bytes = await store.loadSession(remote);
      return bytes !== null ? decodeSession(bytes) : undefined;
    },
    async loadSignedPreKey(keyId: string | number): Promise<KeyPairType | undefined> {
      const bytes = await store.loadSignedPreKey(Number(keyId));
      return bytes !== null ? decodeKeyPair(bytes) : undefined;
    },
    async storeSignedPreKey(): Promise<void> {
      // Signed prekeys are managed by the Identity_Manager / KeyStore, not the library here.
    },
    async removeSignedPreKey(): Promise<void> {
      // No-op: signed-prekey rotation is out of scope for Phase 1.
    },
  };
}

/** Map our {@link SignalAddress} to the library's address (single-device Phase 1 model). */
const protocolAddress = (address: SignalAddress): SignalProtocolAddress =>
  new SignalProtocolAddress(address.uid, REMOTE_DEVICE_ID);

/** Build the library {@link DeviceType} from a claimed (base64) prekey bundle. */
function toDevice(bundle: ClaimedPreKeyBundle): DeviceType {
  return {
    registrationId: bundle.registrationId,
    identityKey: ab(b64decode(bundle.identityKey)),
    signedPreKey: {
      keyId: bundle.signedPreKey.keyId,
      publicKey: ab(b64decode(bundle.signedPreKey.publicKey)),
      signature: ab(b64decode(bundle.signedPreKey.signature)),
    },
    preKey:
      bundle.oneTimePreKey !== null
        ? {
            keyId: bundle.oneTimePreKey.keyId,
            publicKey: ab(b64decode(bundle.oneTimePreKey.publicKey)),
          }
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// Public factories.
// ---------------------------------------------------------------------------

/**
 * Create the pure-TS {@link LibsignalKeyGen} used by the {@link IdentityManager} to
 * generate the device's identity key pair, registration id, and prekey pairs, and to
 * sign the signed prekey. Backed by the library's `KeyHelper` + Curve25519 signing.
 */
export function createPureTsLibsignalKeyGen(): LibsignalKeyGen {
  return {
    async generateIdentityKeyPair(): Promise<GeneratedKeyPair> {
      const pair = await KeyHelper.generateIdentityKeyPair();
      return { publicKey: u8(pair.pubKey), privateKey: u8(pair.privKey) };
    },
    async generateRegistrationId(): Promise<number> {
      // KeyHelper yields a 14-bit id in [0, 16383]; the IdentityManager requires >= 1,
      // so regenerate on the (1/16384) chance of 0.
      let id = KeyHelper.generateRegistrationId();
      while (id < 1) {
        id = KeyHelper.generateRegistrationId();
      }
      return id;
    },
    async generatePreKeyPair(): Promise<GeneratedKeyPair> {
      // The key id is assigned by the IdentityManager; this primitive only needs the
      // key pair, so a fixed placeholder id is fine.
      const preKey = await KeyHelper.generatePreKey(1);
      return { publicKey: u8(preKey.keyPair.pubKey), privateKey: u8(preKey.keyPair.privKey) };
    },
    async signWithIdentity(identityPrivateKey: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
      const curve = await getCurve();
      const signature = await curve.calculateSignature(ab(identityPrivateKey), ab(message));
      return u8(signature);
    },
  };
}

/**
 * Create the pure-TS {@link LibsignalEngine}. All session/identity/prekey state flows
 * through the supplied {@link SignalProtocolStore}; private key material never leaves it.
 * Wire-compatible with any other client using this same engine.
 */
export function createPureTsLibsignalEngine(): LibsignalEngine {
  return {
    async processPreKeyBundle(address, bundle, store): Promise<void> {
      const builder = new SessionBuilder(bridgeStore(store, address), protocolAddress(address));
      await builder.processPreKey(toDevice(bundle));
    },

    async encrypt(address, plaintext, store): Promise<EncryptedMessage> {
      const cipher = new SessionCipher(bridgeStore(store, address), protocolAddress(address));
      const message = await cipher.encrypt(ab(plaintext));
      // Library: 3 = PreKeyWhisperMessage, 1 = WhisperMessage — already the wire codes.
      const type: 1 | 3 = message.type === 3 ? 3 : 1;
      return { type, ciphertext: binaryStringToBytes(message.body ?? '') };
    },

    async decrypt(address, message, store): Promise<Uint8Array> {
      const cipher = new SessionCipher(bridgeStore(store, address), protocolAddress(address));
      const ciphertext = ab(message.ciphertext);
      const plaintext =
        message.type === 3
          ? await cipher.decryptPreKeyWhisperMessage(ciphertext)
          : await cipher.decryptWhisperMessage(ciphertext);
      return u8(plaintext);
    },
  };
}
