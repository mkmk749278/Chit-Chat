/**
 * `apps/mobile` — React Native / Expo binding of the {@link BiometricAttestor} port (Signature
 * Feature 2b, §4.5 "biometric presence attestation").
 *
 * This is the device-specific signing oracle the shared `@chat-app/crypto` `Messaging` orchestrator
 * drives to PROVE that the actual account owner — not someone holding their unlocked phone — is
 * present right now. The proof is a Curve25519 signature over a verifier-issued challenge, produced
 * ONLY after a successful live, strong biometric (Face ID / fingerprint). The signing key is sealed
 * in the OS keystore behind that biometric gate, so a borrower who cannot pass the owner's biometric
 * can never produce the signature — which is the whole point of the feature.
 *
 * Trust model & platform limitation (honest):
 *   - The attestation key pair is a Curve25519 identity key pair (so the core's `verifyCurveSignature`
 *     validates it). The PRIVATE key is stored via `expo-secure-store` with `requireAuthentication:
 *     true` and `keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY`, so the OS only releases it after
 *     a successful device authentication; the PUBLIC key is stored unprotected (it is not secret).
 *   - Before signing we ALSO run an explicit `LocalAuthentication.authenticateAsync` with
 *     `disableDeviceFallback: true` and `biometricsSecurityLevel: 'strong'`, so a PASSCODE fallback is
 *     refused. This matters: the threat is a borrower who may know the passcode but cannot present the
 *     owner's biometric, so passcode fallback would defeat the feature.
 *   - In the Expo MANAGED workflow (no custom native module) this is the strongest primitive available
 *     without ejecting: the biometric gate is enforced by the platform keystore + the strong-biometric
 *     prompt rather than by a hardware-attested key-usage policy. A fully hardware-attested key-usage
 *     binding (e.g. StrongBox `setUserAuthenticationRequired`) would require a custom native module;
 *     this binding is structured so that module can later replace the secure-store sealing without any
 *     change to the shared core or the wire protocol.
 *
 * This module imports native modules and is therefore loaded only on-device; the pure
 * challenge/verify logic it serves is tested separately in `@chat-app/crypto`.
 */

import {
  createPureTsLibsignalKeyGen,
  type BiometricAttestor,
  type LibsignalKeyGen,
} from '@chat-app/crypto';
import { Buffer } from 'buffer';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

/** Stable secure-store keys for the device's attestation key pair (versioned for future rotation). */
const PRIVATE_KEY_STORE_KEY = 'biometric.attest.priv.v1';
const PUBLIC_KEY_STORE_KEY = 'biometric.attest.pub.v1';

/** The OS prompt shown when the private key is released for signing. */
const AUTH_PROMPT = 'Confirm it is really you';

/** base64 helpers (the secure store holds strings; key material rides as base64). */
const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const fromBase64 = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'base64'));

/**
 * Whether the device has strong biometric hardware AND the owner has enrolled a biometric. Returns
 * `false` (never throws) on any platform error so the caller can degrade gracefully to "cannot attest".
 */
async function strongBiometricAvailable(): Promise<boolean> {
  try {
    const [hasHardware, isEnrolled, supported] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
      LocalAuthentication.supportedAuthenticationTypesAsync(),
    ]);
    // Require an actual biometric modality (fingerprint / facial / iris), not merely device security.
    const hasBiometricModality = supported.length > 0;
    return hasHardware && isEnrolled && hasBiometricModality;
  } catch {
    return false;
  }
}

/**
 * Create the device-backed {@link BiometricAttestor}. The Curve25519 attestation key pair is
 * generated lazily on first {@link BiometricAttestor.getPublicKey} and sealed in the keystore behind
 * the biometric gate; subsequent calls reuse it so the peer's enrolled public key stays valid across
 * launches.
 */
export function createExpoBiometricAttestor(): BiometricAttestor {
  const keyGen: LibsignalKeyGen = createPureTsLibsignalKeyGen();

  /**
   * Ensure the attestation key pair exists, returning the PUBLIC key bytes. Generates + seals the
   * pair on first use. Returns `null` when biometrics are unavailable (so nothing is enrolled on a
   * device that cannot attest). The private key is written with `requireAuthentication`, so the OS
   * gates its later retrieval behind device authentication.
   */
  async function ensureKeyPair(): Promise<Uint8Array | null> {
    if (!(await strongBiometricAvailable())) {
      return null;
    }
    const existingPub = await SecureStore.getItemAsync(PUBLIC_KEY_STORE_KEY);
    if (existingPub !== null && existingPub.length > 0) {
      return fromBase64(existingPub);
    }
    // First use on this device: mint a Curve25519 identity key pair and seal the private half behind
    // the biometric gate. The public half is stored unprotected (it is shared in-band at enrolment).
    const pair = await keyGen.generateIdentityKeyPair();
    await SecureStore.setItemAsync(PRIVATE_KEY_STORE_KEY, toBase64(pair.privateKey), {
      requireAuthentication: true,
      authenticationPrompt: AUTH_PROMPT,
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    await SecureStore.setItemAsync(PUBLIC_KEY_STORE_KEY, toBase64(pair.publicKey), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    return pair.publicKey;
  }

  return {
    async isAvailable(): Promise<boolean> {
      return strongBiometricAvailable();
    },

    async getPublicKey(): Promise<Uint8Array | null> {
      try {
        return await ensureKeyPair();
      } catch {
        return null;
      }
    },

    async authenticateAndSign(message: Uint8Array, promptReason: string): Promise<Uint8Array | null> {
      // Ensure the sealed key exists (also gates on biometric availability).
      if ((await ensureKeyPair()) === null) {
        return null;
      }
      // Explicit live, strong biometric. `disableDeviceFallback` REFUSES the passcode path — a
      // borrower who knows the passcode must still fail without the owner's biometric (§4.5).
      let authResult: LocalAuthentication.LocalAuthenticationResult;
      try {
        authResult = await LocalAuthentication.authenticateAsync({
          promptMessage: promptReason.length > 0 ? promptReason : AUTH_PROMPT,
          disableDeviceFallback: true,
          cancelLabel: 'Cancel',
          requireConfirmation: false,
          biometricsSecurityLevel: 'strong',
        });
      } catch {
        return null;
      }
      if (!authResult.success) {
        return null; // cancelled, failed, or no biometric matched — produce no proof.
      }
      // Retrieve the sealed private key (its own `requireAuthentication` gate may re-prompt; that is
      // acceptable and still gated by the live biometric) and sign the challenge message.
      let priv: string | null;
      try {
        priv = await SecureStore.getItemAsync(PRIVATE_KEY_STORE_KEY, {
          requireAuthentication: true,
          authenticationPrompt: promptReason.length > 0 ? promptReason : AUTH_PROMPT,
          keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        });
      } catch {
        return null;
      }
      if (priv === null || priv.length === 0) {
        return null;
      }
      try {
        return await keyGen.signWithIdentity(fromBase64(priv), message);
      } catch {
        return null;
      }
    },
  };
}
