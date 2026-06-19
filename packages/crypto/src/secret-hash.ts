/**
 * `@chat-app/crypto` — salted secret hashing for hidden-chat secrets and app PINs.
 *
 * Signature Features 1 & 4 (`private-chat-app-requirements.md` §3.1, §6): a hidden chat's unlock
 * secret and the real/decoy app PINs must be stored as a **salted hash, never plaintext** (§3.1),
 * and forgotten secrets have no recovery path (D8) — so we only ever persist a verifier, never the
 * secret itself.
 *
 * The requirements name bcrypt; this module instead uses **PBKDF2-HMAC-SHA256** with a random
 * 16-byte salt and a high iteration count, because the shared crypto package is intentionally
 * dependency-free and platform-agnostic (no native addon), and PBKDF2 is the strongest password
 * KDF available through pure WebCrypto on web, Node ≥ 20, and the React Native polyfill alike. The
 * encoded format is self-describing (`pbkdf2$sha256$<iters>$<salt>$<hash>`), so the iteration count
 * can be raised later without breaking already-stored verifiers. (Migrating to argon2/bcrypt behind
 * this same interface is a documented option, tracked in the feature design doc.)
 *
 * Pure WebCrypto; no I/O. Verification uses a constant-time byte comparison so a timing side-channel
 * cannot reveal how many leading bytes of the hash matched (§3.1 "timing-only feedback").
 */

/** KDF identifier embedded in the encoded verifier. */
const SCHEME = 'pbkdf2';
const HASH = 'sha256';

/** Default PBKDF2 iteration count. Tuned for an interactive unlock on a mobile device. */
export const DEFAULT_SECRET_ITERATIONS = 210_000;

/** Salt length in bytes. */
const SALT_BYTES = 16;
/** Derived-key length in bytes (256-bit). */
const KEY_BYTES = 32;

/** The minimal WebCrypto surface this module needs. Declared locally (no DOM lib in this package). */
interface SubtlePbkdf2 {
  importKey(
    format: 'raw',
    keyData: Uint8Array,
    algorithm: { name: 'PBKDF2' },
    extractable: boolean,
    keyUsages: ['deriveBits'],
  ): Promise<CryptoKeyLike>;
  deriveBits(
    algorithm: { name: 'PBKDF2'; salt: Uint8Array; iterations: number; hash: 'SHA-256' },
    baseKey: CryptoKeyLike,
    length: number,
  ): Promise<ArrayBuffer>;
}

/** Opaque imported-key handle; never inspected. */
type CryptoKeyLike = object;

function getSubtle(): SubtlePbkdf2 {
  const subtle = (globalThis as { crypto?: { subtle?: SubtlePbkdf2 } }).crypto?.subtle;
  if (subtle === undefined) {
    throw new Error(
      'secret-hash: WebCrypto subtle is unavailable. The browser and Node ≥ 20 provide it ' +
        'natively; React Native must install it via src/polyfills.ts before use.',
    );
  }
  return subtle;
}

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  const cryptoObj = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (cryptoObj?.getRandomValues === undefined) {
    throw new Error('secret-hash: crypto.getRandomValues is unavailable; cannot generate a salt.');
  }
  cryptoObj.getRandomValues(out);
  return out;
}

const toB64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
const fromB64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));

/** Derive the PBKDF2 bits for `secret` under `salt`/`iterations`. */
async function derive(secret: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const subtle = getSubtle();
  const keyMaterial = new TextEncoder().encode(secret);
  const baseKey = await subtle.importKey('raw', keyMaterial, { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Hash a secret (hidden-chat secret or app PIN) into a self-describing, salted verifier string of
 * the form `pbkdf2$sha256$<iterations>$<saltB64>$<hashB64>`. A fresh random salt is generated each
 * call, so hashing the same secret twice yields different verifiers (§3.1). The plaintext secret is
 * never returned or stored.
 */
export async function hashSecret(
  secret: string,
  iterations: number = DEFAULT_SECRET_ITERATIONS,
): Promise<string> {
  if (secret.length === 0) {
    throw new Error('secret-hash: secret must be non-empty');
  }
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(secret, salt, iterations);
  return `${SCHEME}$${HASH}$${iterations}$${toB64(salt)}$${toB64(hash)}`;
}

/** Constant-time byte-array equality (no early-out on first mismatch). */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
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
 * Verify `secret` against a stored verifier produced by {@link hashSecret}. Returns `false` (never
 * throws) for a non-matching secret or a malformed/foreign verifier string, so a corrupt stored
 * value can't be mistaken for a match. The comparison is constant-time (§3.1 timing-only feedback).
 */
export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 5 || parts[0] !== SCHEME || parts[1] !== HASH) {
    return false;
  }
  const iterations = Number.parseInt(parts[2], 10);
  if (!Number.isInteger(iterations) || iterations <= 0) {
    return false;
  }
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = fromB64(parts[3]);
    expected = fromB64(parts[4]);
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) {
    return false;
  }
  const actual = await derive(secret, salt, iterations);
  return timingSafeEqual(actual, expected);
}
