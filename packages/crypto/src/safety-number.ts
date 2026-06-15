/**
 * `@chat-app/crypto` — safety-number (identity-verification) generator.
 *
 * Phase 2, design Component "Identity verification" (Requirement 1). A safety number is a
 * human-comparable 60-digit code derived from BOTH parties' public identity keys. Two users
 * who read out the same number to each other can be confident no man-in-the-middle sits
 * between them, because the number binds both long-term identity keys and changes if either
 * key changes (Requirements 1.1, 1.3).
 *
 * Construction (mirrors the Signal numeric-fingerprint shape):
 *   per-user fingerprint = 32 bytes of an iterated SHA-512 over `version ‖ identityKey ‖
 *     stableId`, hashed {@link FINGERPRINT_ITERATIONS} times (key-stretching so a brute-force
 *     search for a colliding key is expensive);
 *   displayable digits   = six 5-byte groups of the fingerprint, each big-endian value taken
 *     `mod 100000` and zero-padded to 5 digits → 30 digits per user;
 *   combined number      = the two 30-digit strings ordered deterministically (smaller first)
 *     then concatenated → 60 digits.
 *
 * The deterministic ordering is what guarantees BOTH devices compute the identical number
 * regardless of which side is "local" (Requirement 1.2): each side feeds its own key as
 * local and the peer's as remote, but the sort makes the result symmetric.
 *
 * This module is platform-agnostic and pure: it depends only on WebCrypto `crypto.subtle`
 * (native in the browser and Node ≥ 20; provided on React Native by `src/polyfills.ts`) and
 * does no I/O. It is wire-compatible across web and mobile because both bundle this exact
 * function (Requirement C2). No private key material is referenced — inputs are PUBLIC
 * identity keys only (Requirement 1.6).
 */

/** Key-stretching rounds for the per-user fingerprint (matches Signal's default). */
export const FINGERPRINT_ITERATIONS = 5200;

/** Fingerprint format version, mixed into the hash so a future change can't collide. */
const VERSION = 0;

/** Digits emitted per 5-byte group: `value % 10^5`. */
const DIGITS_PER_GROUP = 5;
/** Number of 5-byte groups taken from each 32-byte fingerprint (→ 30 digits per user). */
const GROUPS_PER_USER = 6;

/**
 * The minimal WebCrypto surface this module needs: just SHA-512 digesting. Declared locally
 * (rather than referencing the DOM `SubtleCrypto` type) because the shared crypto package
 * compiles with `lib: ["ES2022"]` + `types: ["node"]` and no DOM lib. The browser, Node ≥ 20,
 * and the React Native polyfill all satisfy this at runtime.
 */
interface DigestProvider {
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
}

/** Inputs needed to compute a safety number for a 1:1 conversation. */
export interface SafetyNumberInput {
  /** The local user's Firebase UID (stable identifier mixed into their fingerprint). */
  localUid: string;
  /** The local user's PUBLIC identity key bytes. */
  localIdentityKey: Uint8Array;
  /** The remote peer's Firebase UID. */
  remoteUid: string;
  /** The remote peer's PUBLIC identity key bytes (e.g. from `loadIdentityKey`). */
  remoteIdentityKey: Uint8Array;
}

/** A computed safety number, both as raw digits and grouped for display. */
export interface SafetyNumber {
  /** The 60-digit safety number with no separators. */
  raw: string;
  /** The same digits grouped into 12 blocks of 5 for easier reading/comparison. */
  formatted: string;
}

/** Concatenate byte arrays into one buffer. */
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Resolve the WebCrypto `subtle` surface, with a clear error if the host lacks it. */
function getSubtle(): DigestProvider {
  const subtle = (globalThis as { crypto?: { subtle?: DigestProvider } }).crypto?.subtle;
  if (subtle === undefined) {
    throw new Error(
      'safety-number: WebCrypto subtle is unavailable. The browser and Node ≥ 20 provide it ' +
        'natively; React Native must install it via src/polyfills.ts before use.',
    );
  }
  return subtle;
}

/** One SHA-512 digest over `data`, returned as raw bytes. */
async function sha512(subtle: DigestProvider, data: Uint8Array): Promise<Uint8Array> {
  // Copy into a standalone ArrayBuffer so a subarray view never leaks extra bytes into the digest.
  const buf = new Uint8Array(data.length);
  buf.set(data);
  return new Uint8Array(await subtle.digest('SHA-512', buf));
}

/**
 * Compute one user's 32-byte fingerprint: iterate SHA-512 over `version ‖ identityKey ‖
 * stableId`, folding the identity key back in each round so the whole key (not just a prefix)
 * influences every iteration.
 */
async function userFingerprint(
  subtle: DigestProvider,
  stableId: string,
  identityKey: Uint8Array,
): Promise<Uint8Array> {
  const versionBytes = new Uint8Array([(VERSION >> 8) & 0xff, VERSION & 0xff]);
  const idBytes = new TextEncoder().encode(stableId);
  let hash = await sha512(subtle, concatBytes(versionBytes, identityKey, idBytes));
  for (let i = 0; i < FINGERPRINT_ITERATIONS; i += 1) {
    hash = await sha512(subtle, concatBytes(hash, identityKey));
  }
  return hash.subarray(0, GROUPS_PER_USER * DIGITS_PER_GROUP);
}

/** Turn a fingerprint into its 30 displayable digits (six 5-byte groups, each `% 10^5`). */
function displayDigits(fingerprint: Uint8Array): string {
  let digits = '';
  for (let group = 0; group < GROUPS_PER_USER; group += 1) {
    const start = group * DIGITS_PER_GROUP;
    // 5 bytes → a value < 2^40, safely within Number's integer range.
    let value = 0;
    for (let b = 0; b < DIGITS_PER_GROUP; b += 1) {
      value = value * 256 + fingerprint[start + b];
    }
    const chunk = (value % 100000).toString().padStart(DIGITS_PER_GROUP, '0');
    digits += chunk;
  }
  return digits;
}

/** Group a digit string into space-separated blocks of 5 for display. */
function groupForDisplay(digits: string): string {
  return (digits.match(/.{1,5}/g) ?? []).join(' ');
}

/**
 * Compute the conversation's safety number from both parties' PUBLIC identity keys.
 *
 * Deterministic and symmetric: `compute({localUid:A, remoteUid:B, …})` and
 * `compute({localUid:B, remoteUid:A, …})` yield the same {@link SafetyNumber.raw}, so the two
 * devices display an identical code to read out to each other (Requirements 1.1, 1.2). Changing
 * either identity key changes the result (Requirement 1.3).
 *
 * @throws if either identity key is empty or WebCrypto is unavailable.
 */
export async function computeSafetyNumber(input: SafetyNumberInput): Promise<SafetyNumber> {
  if (input.localIdentityKey.length === 0 || input.remoteIdentityKey.length === 0) {
    throw new Error('safety-number: identity keys must be non-empty public key bytes');
  }
  const subtle = getSubtle();

  const [localFp, remoteFp] = await Promise.all([
    userFingerprint(subtle, input.localUid, input.localIdentityKey),
    userFingerprint(subtle, input.remoteUid, input.remoteIdentityKey),
  ]);

  const localDigits = displayDigits(localFp);
  const remoteDigits = displayDigits(remoteFp);

  // Order deterministically so both devices produce the SAME combined number (1.2).
  const [first, second] =
    localDigits <= remoteDigits ? [localDigits, remoteDigits] : [remoteDigits, localDigits];
  const raw = first + second;

  return { raw, formatted: groupForDisplay(raw) };
}
