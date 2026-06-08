/**
 * `@chat-app/crypto` — `IdentityManager` (Phase 1, design Client Component 2).
 *
 * Source of truth: `.kiro/specs/phase1-client-messaging/design.md` →
 *   "Components and Interfaces" → "Client Component 2: Identity_Manager", and
 *   `.kiro/specs/phase1-client-messaging/requirements.md` → Requirement 2
 *   (Local libsignal Identity Generation), plus Requirements 7.5 and 8.1.
 *
 * Generates, holds, and exposes the device's libsignal identity material. Private
 * key halves are written ONLY through the injected `KeyStore` and are never placed
 * on any value handed out of this module — the exposed bundle is public-only,
 * base64-encoded material (Requirements 2.4, 2.5, 7.5, 8.1).
 *
 * Key generation is delegated to the injected {@link LibsignalKeyGen} port rather
 * than imported statically here. This keeps the core platform-agnostic and unit
 * testable with a deterministic fake, and it lets the platform apps bind the real
 * `@signalapp/libsignal-client` native bindings (mobile) / WASM (web) without this
 * module depending on those bindings at type-check time. A real-library-backed
 * adapter factory ({@link createLibsignalKeyGen}) is provided below.
 *
 * All correctness invariants from Requirement 2 are enforced HERE, independent of
 * the generator: registration id >= 1 (2.3), one-time batch size 1..200 (2.2),
 * non-negative and batch-unique one-time key ids (2.3), and atomic persistence —
 * the complete `IdentityRecord` is assembled in memory and written with a single
 * `KeyStore.saveIdentity` call; on any generation failure nothing is persisted and
 * an error is thrown (2.7, 2.8).
 */

import type { PublicPreKeyBundleOut } from '@chat-app/types';
import type {
  IdentityRecord,
  KeyStore,
  OneTimePreKeyRecord,
  SignedPreKeyRecord,
} from './ports';

// ---------------------------------------------------------------------------
// Public component contract (design Client Component 2).
// ---------------------------------------------------------------------------

/**
 * Generates, holds, and exposes the device's libsignal identity material. Private
 * keys never leave the device (Requirements 2.1–2.8, 7.5, 8.1).
 */
export interface IdentityManager {
  /**
   * Idempotently ensure a complete identity exists for `uid` on this device.
   * Generates the full identity set on the first call for a device with no stored
   * identity; reuses the stored identity thereafter rather than generating a new
   * identity key pair or registration id (Requirement 2.6).
   *
   * @returns the public-only prekey bundle for `uid`.
   * @throws {IdentityGenerationError} if generation fails before the complete set is
   *   produced — in which case nothing is persisted (Requirement 2.7).
   */
  ensureIdentity(uid: string): Promise<PublicPreKeyBundleOut>;

  /**
   * The public-only bundle to register with the Device_Registrar — base64 strings,
   * never private material (Requirements 2.5, 8.1).
   *
   * @throws {Error} if called before {@link IdentityManager.ensureIdentity} has
   *   established (generated or loaded) an identity on this instance.
   */
  getPublicBundle(): Promise<PublicPreKeyBundleOut>;
}

// ---------------------------------------------------------------------------
// Injected key-generation port (swappable libsignal binding).
// ---------------------------------------------------------------------------

/** A raw libsignal key pair: public + PRIVATE halves as serialized bytes. */
export interface GeneratedKeyPair {
  /** Serialized PUBLIC key bytes. */
  publicKey: Uint8Array;
  /** Serialized PRIVATE key bytes — retained only inside the Key_Store. */
  privateKey: Uint8Array;
}

/**
 * The narrow libsignal primitive surface the `IdentityManager` drives. Implemented
 * by {@link createLibsignalKeyGen} (real `@signalapp/libsignal-client`) in the
 * platform apps, or by a deterministic fake in tests.
 *
 * INTERFACE ONLY — the `IdentityManager` owns all batch sizing, key-id assignment,
 * and invariant enforcement; this port produces only the raw cryptographic material.
 */
export interface LibsignalKeyGen {
  /** Generate the device's long-term identity key pair (public + PRIVATE). */
  generateIdentityKeyPair(): Promise<GeneratedKeyPair>;
  /** Generate a libsignal registration id. The manager re-checks it is >= 1 (2.3). */
  generateRegistrationId(): Promise<number>;
  /** Generate one Curve key pair, used for a signed prekey or a one-time prekey. */
  generatePreKeyPair(): Promise<GeneratedKeyPair>;
  /**
   * Produce the signed-prekey signature: sign `message` (the signed prekey's PUBLIC
   * key bytes) with the identity PRIVATE key (Requirement 2.1).
   */
  signWithIdentity(identityPrivateKey: Uint8Array, message: Uint8Array): Promise<Uint8Array>;
}

// ---------------------------------------------------------------------------
// Configuration + errors.
// ---------------------------------------------------------------------------

/** Inclusive lower bound on a generated one-time prekey batch (Requirement 2.2). */
export const MIN_ONE_TIME_PREKEYS = 1;
/** Inclusive upper bound on a generated one-time prekey batch (Requirement 2.2). */
export const MAX_ONE_TIME_PREKEYS = 200;
/** Default one-time prekey batch size when none is configured (within 1..200). */
export const DEFAULT_ONE_TIME_PREKEYS = 100;
/** Fixed key id assigned to the device's active signed prekey (non-negative) (2.3). */
export const SIGNED_PREKEY_ID = 0;

/** Options for {@link DefaultIdentityManager}. */
export interface IdentityManagerOptions {
  /**
   * Size of the one-time prekey batch to generate. Must be within the inclusive
   * range 1..200 (Requirement 2.2). Defaults to {@link DEFAULT_ONE_TIME_PREKEYS}.
   */
  oneTimePreKeyCount?: number;
}

/**
 * Raised when identity generation fails before the complete identity set is
 * produced. Surfacing this distinct type lets callers tell a generation failure
 * (nothing persisted — Requirement 2.7) apart from other errors.
 */
export class IdentityGenerationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'IdentityGenerationError';
  }
}

// ---------------------------------------------------------------------------
// Default implementation.
// ---------------------------------------------------------------------------

/**
 * Default {@link IdentityManager} backed by an injected {@link KeyStore} and
 * {@link LibsignalKeyGen}.
 *
 * Generation flow (Requirement 2.1) on a device with no stored identity:
 *   1. identity key pair, 2. registration id (re-checked >= 1), 3. signed prekey
 *   pair + signature over its public key by the identity key, 4. a 1..200 batch of
 *   one-time prekeys with non-negative, batch-unique key ids.
 *
 * The complete {@link IdentityRecord} is assembled in memory and written with a
 * single {@link KeyStore.saveIdentity} call, so a generation failure leaves nothing
 * persisted (Requirements 2.7, 2.8). Private halves live only in the record handed
 * to the store; the value returned to callers is public-only base64 (2.4, 2.5, 8.1).
 */
export class DefaultIdentityManager implements IdentityManager {
  private readonly oneTimePreKeyCount: number;

  /** The established identity for this instance, cached after generate/load. */
  private current: IdentityRecord | null = null;

  /**
   * @param keyStore - on-device store; the only sink for private key material
   *   (SQLCipher on mobile, in-memory on web) (Requirements 7.5, 8.1).
   * @param keyGen - swappable libsignal key-generation port.
   * @param options - batch sizing; validated against the 1..200 bound.
   */
  constructor(
    private readonly keyStore: KeyStore,
    private readonly keyGen: LibsignalKeyGen,
    options: IdentityManagerOptions = {},
  ) {
    const count = options.oneTimePreKeyCount ?? DEFAULT_ONE_TIME_PREKEYS;
    if (!Number.isInteger(count) || count < MIN_ONE_TIME_PREKEYS || count > MAX_ONE_TIME_PREKEYS) {
      throw new RangeError(
        `oneTimePreKeyCount must be an integer within ${MIN_ONE_TIME_PREKEYS}..${MAX_ONE_TIME_PREKEYS}, got ${String(count)}`,
      );
    }
    this.oneTimePreKeyCount = count;
  }

  /** @inheritdoc */
  async ensureIdentity(uid: string): Promise<PublicPreKeyBundleOut> {
    // Reuse stored identity when one already exists for this user (Requirement 2.6).
    const stored = await this.keyStore.loadIdentity(uid);
    if (stored !== null) {
      this.current = stored;
      return toPublicBundle(stored);
    }

    const record = await this.generateIdentity(uid);

    // Atomic persist: a single write of the complete set, or nothing (2.7, 2.8).
    // Generation already completed above, so reaching here means the full set exists.
    await this.keyStore.saveIdentity(record);
    this.current = record;
    return toPublicBundle(record);
  }

  /** @inheritdoc */
  async getPublicBundle(): Promise<PublicPreKeyBundleOut> {
    if (this.current === null) {
      throw new Error('No identity established; call ensureIdentity(uid) first.');
    }
    return toPublicBundle(this.current);
  }

  /**
   * Generate the complete identity set in memory. Any failure here throws an
   * {@link IdentityGenerationError} before {@link KeyStore.saveIdentity} is reached,
   * so no partial material is ever persisted (Requirement 2.7).
   */
  private async generateIdentity(uid: string): Promise<IdentityRecord> {
    try {
      // 1. Identity key pair.
      const identity = await this.keyGen.generateIdentityKeyPair();

      // 2. Registration id — enforce the >= 1 invariant regardless of generator (2.3).
      const registrationId = await this.keyGen.generateRegistrationId();
      if (!Number.isInteger(registrationId) || registrationId < 1) {
        throw new IdentityGenerationError(
          `registrationId must be an integer >= 1, got ${String(registrationId)}`,
        );
      }

      // 3. Signed prekey: a fresh key pair plus a signature over its PUBLIC key by
      //    the identity key (Requirement 2.1).
      const signedPair = await this.keyGen.generatePreKeyPair();
      const signature = await this.keyGen.signWithIdentity(
        identity.privateKey,
        signedPair.publicKey,
      );
      const signedPreKey: SignedPreKeyRecord = {
        keyId: SIGNED_PREKEY_ID,
        publicKey: signedPair.publicKey,
        privateKey: signedPair.privateKey,
        signature,
      };

      // 4. One-time prekey batch (size already validated to 1..200). Key ids are
      //    sequential from 0, so they are non-negative and unique within the batch
      //    (Requirements 2.2, 2.3).
      const oneTimePreKeys: OneTimePreKeyRecord[] = [];
      for (let keyId = 0; keyId < this.oneTimePreKeyCount; keyId += 1) {
        const pair = await this.keyGen.generatePreKeyPair();
        oneTimePreKeys.push({
          keyId,
          publicKey: pair.publicKey,
          privateKey: pair.privateKey,
        });
      }

      return {
        uid,
        registrationId,
        identityKeyPublic: identity.publicKey,
        identityKeyPrivate: identity.privateKey,
        signedPreKey,
        oneTimePreKeys,
        createdAt: Date.now(),
      };
    } catch (error) {
      if (error instanceof IdentityGenerationError) {
        throw error;
      }
      throw new IdentityGenerationError('libsignal identity generation failed', {
        cause: error,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Public-only bundle projection (Requirements 2.4, 2.5, 8.1).
// ---------------------------------------------------------------------------

/**
 * Project an {@link IdentityRecord} onto the public-only {@link PublicPreKeyBundleOut}.
 * Only public material is read and every byte string is base64-encoded; no private
 * field is referenced, so there is no path by which a private key could be exposed
 * (Requirements 2.4, 2.5, 8.1).
 */
function toPublicBundle(record: IdentityRecord): PublicPreKeyBundleOut {
  return {
    registrationId: record.registrationId,
    identityKey: toBase64(record.identityKeyPublic),
    signedPreKey: {
      keyId: record.signedPreKey.keyId,
      publicKey: toBase64(record.signedPreKey.publicKey),
      signature: toBase64(record.signedPreKey.signature),
    },
    oneTimePreKeys: record.oneTimePreKeys.map((otp) => ({
      keyId: otp.keyId,
      publicKey: toBase64(otp.publicKey),
    })),
  };
}

/** Encode raw key bytes as base64 — the on-the-wire shape of public material. */
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

// ---------------------------------------------------------------------------
// Real-library-backed adapter (`@signalapp/libsignal-client`).
//
// The Node-only `createLibsignalKeyGen()` factory lives in `./libsignal-keygen.node`
// and is intentionally NOT re-exported from the package index: it lazily loads the
// native library via a dynamic (variable) specifier, which the React Native bundler
// (Metro) rejects. Node consumers import it directly from that module.
// ---------------------------------------------------------------------------
