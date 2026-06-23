/**
 * `apps/mobile` — durable, encrypted-at-rest {@link BiometricEnrollmentStore} (Signature Feature 2b,
 * §4.5 "biometric presence attestation").
 *
 * This is the PRODUCTION backing for the narrow {@link BiometricEnrollmentStore} port that
 * `@chat-app/crypto`'s `Messaging` consumes to verify a peer's live-biometric presence proofs. It
 * binds that port to the SAME on-device encrypted vault the mobile {@link KeyStore} already uses —
 * the {@link PersistentVault}'s single AES-256-CBC+HMAC blob, whose data-encryption key lives in the
 * hardware-backed Android Keystore (`expo-secure-store`). Persisting a peer's enrolled PUBLIC
 * attestation key here means a verification works across app restarts without re-enrolling.
 *
 * Only PUBLIC key material is stored — never any secret — but it is kept inside the encrypted blob
 * for consistency with the rest of the vault, and base64-encoded so the JSON document is text-safe
 * before it is encrypted. Each write is a single {@link PersistentVault.mutate}, i.e. one
 * all-or-nothing encrypted blob write (mirrors `createVaultShadowSecretPersistence`).
 *
 * The adapter is pure orchestration over the injected vault — no cryptography of its own and no RN
 * imports — so it round-trips identically under Node (tests) and on-device.
 */

import type { BiometricEnrollmentStore } from '@chat-app/crypto';
import { Buffer } from 'buffer';

import type { PersistentVault } from '../crypto/persistent-store';

/**
 * Build the durable {@link BiometricEnrollmentStore} over the encrypted {@link PersistentVault}. The
 * same vault instance the controller opens for identity/messaging state is reused, so the enrolled
 * peer keys share its single encrypted blob and its hardware-backed data-encryption key.
 */
export function createVaultBiometricEnrollment(vault: PersistentVault): BiometricEnrollmentStore {
  return {
    async savePeerAttestationKey(peerUid: string, publicKey: Uint8Array): Promise<void> {
      // Single atomic mutate → one encrypted blob write; an upsert keyed by peer uid (re-enrolling
      // the same peer replaces their prior key, e.g. after a device/key reset).
      await vault.mutate((doc) => {
        const section = doc.biometricEnrollment ?? {};
        section[peerUid] = Buffer.from(publicKey).toString('base64');
        doc.biometricEnrollment = section;
      });
    },

    async loadPeerAttestationKey(peerUid: string): Promise<Uint8Array | null> {
      return vault.read((doc) => {
        const stored = doc.biometricEnrollment?.[peerUid];
        if (typeof stored !== 'string' || stored.length === 0) {
          return null;
        }
        return new Uint8Array(Buffer.from(stored, 'base64'));
      });
    },
  };
}
