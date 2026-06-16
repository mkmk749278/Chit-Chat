/**
 * `@chat-app/crypto` — `SessionManager` (Phase 1, design Component 5: Messaging).
 *
 * Source of truth: `.kiro/specs/phase1-client-messaging/design.md` →
 *   "Components and Interfaces" → "Client Component 5: Messaging" → `SessionManager`.
 *
 * The `SessionManager` is the libsignal session orchestrator for 1:1 messaging. It:
 *   - reports whether a libsignal session already exists for a recipient (`hasSession`),
 *   - builds a session from a claimed PUBLIC prekey bundle and persists the resulting
 *     session state (`establishSession`, Requirements 5.1, 5.8),
 *   - encrypts outbound plaintext into a libsignal `CiphertextBody` (`encrypt`,
 *     Requirements 5.1, 5.2), and
 *   - decrypts an inbound `CiphertextEnvelope` back to plaintext (`decrypt`,
 *     Requirement 5.4).
 *
 * All libsignal session/identity/prekey state is read and written through the injected
 * {@link SignalProtocolStore}. That store is, in turn, backed on-device by the `KeyStore`
 * (SQLCipher on mobile, in-memory on web), so session records are persisted through
 * `KeyStore.saveSession` and private key material never leaves the device
 * (Requirements 5.8, 7.1, 8.1).
 *
 * The actual native libsignal session-building / cipher calls are isolated behind the
 * thin {@link LibsignalEngine} port. This module deliberately does NOT statically import
 * `@signalapp/libsignal-client`: the native binding is supplied by the platform adapter
 * (a later task) so the shared core stays platform-independent and type-checkable without
 * the native artifact present. See {@link createUnboundLibsignalEngine} for the TODO that
 * binds the real native library.
 */

import type { CiphertextBody, CiphertextEnvelope } from '@chat-app/types';
import type { ClaimedPreKeyBundle } from '@chat-app/types';

import type { SignalAddress, SignalProtocolStore } from './ports';
import { computeSafetyNumber, type SafetyNumber } from './safety-number';

/**
 * A libsignal-encrypted message in raw byte form. `type` is the libsignal framing
 * (1 = SignalMessage / whisper, 3 = PreKeySignalMessage), NOT message content. The
 * `SessionManager` base64-encodes/decodes the `ciphertext` at the wire boundary; the
 * engine works purely in bytes.
 */
export interface EncryptedMessage {
  /** libsignal message type: 1 = SignalMessage, 3 = PreKeySignalMessage. */
  type: 1 | 3;
  /** Raw libsignal ciphertext bytes (opaque). */
  ciphertext: Uint8Array;
}

/**
 * The thin, injected boundary around the native `@signalapp/libsignal-client`
 * session-building and cipher APIs. Every method operates over the supplied
 * {@link SignalProtocolStore}, so all session/identity/prekey reads and writes flow
 * through on-device storage (Requirements 5.1, 5.2, 5.4, 5.8, 8.1).
 *
 * Keeping libsignal behind this port lets the shared `SessionManager` be written,
 * type-checked, and unit/property-tested without the native artifact, while the
 * platform adapter binds the real engine at runtime.
 */
export interface LibsignalEngine {
  /**
   * Build a libsignal session for `address` from the recipient's claimed PUBLIC prekey
   * bundle and persist the resulting session (and trusted identity) through `store`
   * (Requirements 5.1, 5.8). The bundle carries base64 public material only; the engine
   * owns the base64→libsignal decode since it owns the native library.
   */
  processPreKeyBundle(
    address: SignalAddress,
    bundle: ClaimedPreKeyBundle,
    store: SignalProtocolStore,
  ): Promise<void>;

  /**
   * Encrypt `plaintext` for `address` using the established session, persisting any
   * updated session state through `store`. Returns the libsignal framing type and raw
   * ciphertext bytes (Requirements 5.1, 5.2).
   */
  encrypt(
    address: SignalAddress,
    plaintext: Uint8Array,
    store: SignalProtocolStore,
  ): Promise<EncryptedMessage>;

  /**
   * Decrypt `message` from `address`, persisting updated session state through `store`.
   * A type-3 (PreKeySignalMessage) input establishes/advances the inbound session and
   * consumes the matching one-time prekey via `store.removePreKey`; a type-1
   * (SignalMessage) input advances an existing session. Returns the raw plaintext bytes,
   * or rejects if decryption fails (Requirements 5.4, 5.5).
   */
  decrypt(
    address: SignalAddress,
    message: EncryptedMessage,
    store: SignalProtocolStore,
  ): Promise<Uint8Array>;
}

/**
 * Establishes libsignal sessions from claimed prekey bundles and encrypts/decrypts 1:1
 * messages over the persisted session state (design Component 5; Requirements 5.1, 5.2,
 * 5.4, 5.8).
 */
export interface SessionManager {
  /** Whether a persisted libsignal session already exists for `recipientUid` (5.1). */
  hasSession(recipientUid: string): Promise<boolean>;
  /**
   * Build a libsignal session from the recipient's claimed PUBLIC prekey bundle and
   * persist the resulting session state (Requirements 5.1, 5.8).
   */
  establishSession(recipientUid: string, bundle: ClaimedPreKeyBundle): Promise<void>;
  /**
   * Encrypt `plaintext` into a libsignal ciphertext body addressed to `recipientUid`
   * (Requirements 5.1, 5.2). The returned `ciphertext` is base64-encoded for the wire.
   */
  encrypt(recipientUid: string, plaintext: string): Promise<CiphertextBody>;
  /**
   * Decrypt an inbound `CiphertextEnvelope` to plaintext, persisting updated session
   * state (Requirement 5.4). Rejects if libsignal decryption fails so the caller can
   * surface a delivery-error without rendering plaintext (5.5).
   */
  decrypt(envelope: CiphertextEnvelope): Promise<string>;
  /**
   * Derive the conversation's deterministic 60-digit safety number from BOTH parties' PUBLIC
   * identity keys (Requirement 1.1–1.3). Resolves `null` until the peer's identity key is known
   * (no session established and no message received yet), so the UI can show "not available
   * until you exchange a message". Entirely client-side; no private material is referenced
   * beyond the local identity key already held on-device (Requirement 1.6).
   */
  getSafetyNumber(localUid: string, recipientUid: string): Promise<SafetyNumber | null>;
}

/**
 * Convert a UTF-8 string to bytes. Uses `TextEncoder`, which is available in Node, React
 * Native (Hermes), and browsers, keeping the shared core platform-independent.
 */
function utf8ToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Convert UTF-8 bytes back to a string. */
function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Base64-encode raw bytes for the wire (libsignal ciphertext body). */
function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** Decode a base64 wire string back to raw bytes. */
function base64ToBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/**
 * Default {@link SessionManager} backed by an injected {@link SignalProtocolStore} and a
 * {@link LibsignalEngine}.
 *
 * Phase 1 models a single device per user, so the remote {@link SignalAddress} is the
 * recipient's UID plus the `deviceId` carried by the claimed bundle (on send) or by the
 * inbound envelope (on receive). The manager learns and caches that `uid → deviceId`
 * mapping as sessions are established and envelopes are received, so `hasSession`/`encrypt`
 * — which are only given a `recipientUid` — can resolve the full address.
 */
export class DefaultSessionManager implements SessionManager {
  /** Learned `recipientUid → deviceId` mapping for address resolution (single device/user). */
  private readonly knownDevices = new Map<string, string>();

  /**
   * @param store  - the libsignal-facing store surface, backed on-device by the `KeyStore`
   *   (SQLCipher / in-memory). All session, identity, and prekey state is read/written
   *   through it, so sessions persist via `KeyStore.saveSession` (Requirements 5.8, 8.1).
   * @param engine - the thin boundary around the native libsignal session/cipher APIs.
   */
  constructor(
    private readonly store: SignalProtocolStore,
    private readonly engine: LibsignalEngine,
  ) {}

  /** @inheritdoc */
  async hasSession(recipientUid: string): Promise<boolean> {
    const address = this.resolveAddress(recipientUid);
    if (address === null) {
      return false;
    }
    const record = await this.store.loadSession(address);
    return record !== null;
  }

  /** @inheritdoc */
  async establishSession(recipientUid: string, bundle: ClaimedPreKeyBundle): Promise<void> {
    const address: SignalAddress = { uid: recipientUid, deviceId: bundle.deviceId };
    // Remember the recipient's device so a later encrypt()/hasSession() can resolve it.
    this.knownDevices.set(recipientUid, bundle.deviceId);
    // The engine builds the libsignal session from the PUBLIC bundle and persists the
    // session + trusted identity through the store (Requirements 5.1, 5.8).
    await this.engine.processPreKeyBundle(address, bundle, this.store);
  }

  /** @inheritdoc */
  async encrypt(recipientUid: string, plaintext: string): Promise<CiphertextBody> {
    const address = this.resolveAddress(recipientUid);
    if (address === null) {
      throw new Error(
        `No libsignal session is established for recipient "${recipientUid}"; ` +
          'call establishSession() before encrypt().',
      );
    }
    const message = await this.engine.encrypt(address, utf8ToBytes(plaintext), this.store);
    return { type: message.type, ciphertext: bytesToBase64(message.ciphertext) };
  }

  /** @inheritdoc */
  async decrypt(envelope: CiphertextEnvelope): Promise<string> {
    const address: SignalAddress = {
      uid: envelope.senderUid,
      deviceId: envelope.senderDeviceId,
    };
    // Learn the sender's device so subsequent outbound messages can resolve the address.
    this.knownDevices.set(envelope.senderUid, envelope.senderDeviceId);
    const plaintext = await this.engine.decrypt(
      address,
      { type: envelope.type, ciphertext: base64ToBytes(envelope.ciphertext) },
      this.store,
    );
    return bytesToUtf8(plaintext);
  }

  /** @inheritdoc */
  async getSafetyNumber(localUid: string, recipientUid: string): Promise<SafetyNumber | null> {
    const address = this.resolveAddress(recipientUid);
    if (address === null) {
      return null;
    }
    const remoteIdentityKey = await this.store.loadIdentityKey(address);
    if (remoteIdentityKey === null) {
      return null;
    }
    const localKeyPair = await this.store.getIdentityKeyPair();
    return computeSafetyNumber({
      localUid,
      localIdentityKey: localKeyPair.publicKey,
      remoteUid: recipientUid,
      remoteIdentityKey,
    });
  }

  /**
   * Resolve a `recipientUid` to its full {@link SignalAddress} using the learned
   * device mapping, or `null` when no device is known yet (no session has been
   * established and no envelope received for that recipient).
   */
  private resolveAddress(recipientUid: string): SignalAddress | null {
    const deviceId = this.knownDevices.get(recipientUid);
    if (deviceId === undefined) {
      return null;
    }
    return { uid: recipientUid, deviceId };
  }
}

/**
 * Create a {@link SessionManager} over the injected {@link SignalProtocolStore} and
 * {@link LibsignalEngine}. The store is the libsignal-facing surface (backed on-device by
 * the `KeyStore`); the engine is the thin native-libsignal boundary supplied by the
 * platform adapter.
 */
export function createSessionManager(
  store: SignalProtocolStore,
  engine: LibsignalEngine,
): SessionManager {
  return new DefaultSessionManager(store, engine);
}

/**
 * Placeholder {@link LibsignalEngine} whose every method throws. It lets the shared core
 * be assembled and type-checked before the native binding exists.
 *
 * TODO(phase-1 adapter): replace this with the real engine that wraps
 * `@signalapp/libsignal-client`. The concrete implementation will, over the injected
 * {@link SignalProtocolStore}:
 *   - `processPreKeyBundle`: construct a `PreKeyBundle` from the claimed bundle's base64
 *     fields and call `processPreKeyBundle(bundle, ProtocolAddress, sessionStore,
 *     identityStore)` to build and persist the session.
 *   - `encrypt`: call `signalEncrypt(message, ProtocolAddress, sessionStore,
 *     identityStore)` and map the resulting `CiphertextMessageType` to 1 | 3.
 *   - `decrypt`: for type 3, `signalDecryptPreKey(PreKeySignalMessage.deserialize(...),
 *     ...)` (consuming the matching one-time prekey via `removePreKey`); for type 1,
 *     `signalDecrypt(SignalMessage.deserialize(...), ...)`.
 * This native binding lands with the platform Key_Store / SignalProtocolStore adapter
 * task; the shared `SessionManager` above needs no change when it does.
 */
export function createUnboundLibsignalEngine(): LibsignalEngine {
  const unbound = (): never => {
    throw new Error(
      'LibsignalEngine is not bound: the native @signalapp/libsignal-client binding is ' +
        'supplied by the platform adapter. See createUnboundLibsignalEngine TODO.',
    );
  };
  return {
    processPreKeyBundle: unbound,
    encrypt: unbound,
    decrypt: unbound,
  };
}
