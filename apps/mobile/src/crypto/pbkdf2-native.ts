/**
 * Native, off-thread PBKDF2 provider for the shared `secret-hash` core (P1 freeze fix,
 * `ui-modernization-and-setup-fix` design Component 2; Requirements 1.1, 1.2, 4.8).
 *
 * The pure core (`packages/crypto/src/secret-hash.ts`) routes its single expensive primitive — the
 * 210k-iteration PBKDF2-HMAC-SHA256 derivation — through an injected {@link Pbkdf2Provider}. On
 * Hermes the default WebCrypto path is the pure-JS `msrcrypto` shim, which runs those 210k
 * iterations *synchronously on the single JS thread* and freezes the UI for seconds. This adapter
 * binds the port to `react-native-quick-crypto`, whose `pbkdf2` is implemented in C/C++ over JSI and
 * runs the derivation on a **background thread**, so the JS/UI thread stays responsive even at the
 * full iteration count.
 *
 * Security is unchanged: this only moves *where* the bytes are computed. The verifier format, salt
 * handling, iteration count (>= 210000), and constant-time compare all live in the pure core and are
 * untouched. The function computes standard PBKDF2-HMAC-SHA256 (RFC 8018), so a verifier produced by
 * this provider and one produced by the WebCrypto default are interchangeable (no re-hash/migration).
 *
 * No plaintext is retained: the password bytes are handed straight to the native call and never
 * stored, logged, or closed over beyond the lifetime of the single derivation.
 */

import { Buffer } from 'buffer';
import QuickCrypto from 'react-native-quick-crypto';
import type { Pbkdf2Provider } from '@chat-app/crypto';

/** The node-`crypto`-compatible `pbkdf2` surface this adapter needs from react-native-quick-crypto. */
interface QuickCryptoPbkdf2 {
  pbkdf2(
    password: Buffer,
    salt: Buffer,
    iterations: number,
    keylen: number,
    digest: string,
    callback: (err: Error | null, derivedKey?: Buffer) => void,
  ): void;
}

/**
 * Native PBKDF2 provider backed by react-native-quick-crypto (JSI, background thread). Resolves the
 * derived bytes as a `Uint8Array` and rejects on any native error; retains no plaintext.
 */
export const nativePbkdf2Provider: Pbkdf2Provider = {
  deriveBits(
    password: Uint8Array,
    salt: Uint8Array,
    iterations: number,
    keyLenBytes: number,
  ): Promise<Uint8Array> {
    const quick = QuickCrypto as unknown as QuickCryptoPbkdf2;
    return new Promise<Uint8Array>((resolve, reject) => {
      quick.pbkdf2(
        Buffer.from(password),
        Buffer.from(salt),
        iterations,
        keyLenBytes,
        'sha256',
        (err, derived) => {
          if (err !== null && err !== undefined) {
            reject(err);
            return;
          }
          if (derived === undefined) {
            reject(new Error('pbkdf2-native: native pbkdf2 returned no derived key'));
            return;
          }
          resolve(new Uint8Array(derived));
        },
      );
    });
  },
};
