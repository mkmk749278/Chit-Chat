/**
 * `@chat-app/crypto` — in-chat identity verification (rotating TOTP + duress code).
 *
 * Signature Feature 2 (`private-chat-app-requirements.md` §4; decision D6). E2E encryption
 * verifies the channel and the device keys — not the human at the keyboard. Anyone holding an
 * unlocked device can message as the owner. This module provides the cryptographic heart of the
 * in-chat verification challenge that confirms the responder possesses the conversation's shared
 * verification secret, with a second "duress" answer that looks identical to an observer but is
 * distinguishable to the app so it can fire a silent alert (§4.2, §4.3).
 *
 * Construction:
 *   - A 32-byte **verification seed** is generated once at setup, exchanged over the existing
 *     E2E channel (never to the server), and stored encrypted on each device (§4.2). Both peers
 *     hold the same seed, so both compute the same rotating codes without server involvement.
 *   - From the one seed we derive two independent HMAC sub-keys by domain separation, so the
 *     "normal" and "duress" code streams cannot be predicted from each other:
 *         normalKey = HMAC-SHA256(seed, "chit-chat/identity-verify/normal/v1")
 *         duressKey = HMAC-SHA256(seed, "chit-chat/identity-verify/duress/v1")
 *   - Each code is a standard **RFC 6238 TOTP** (= RFC 4226 HOTP over HMAC-SHA1) of the sub-key
 *     with a {@link VERIFICATION_STEP_SECONDS}-second time step, so the valid answer rotates every
 *     60 s and a captured code cannot be replayed in a later step (§4.2).
 *
 * The module is platform-agnostic and pure: it depends only on WebCrypto (`crypto.subtle` for
 * HMAC, `crypto.getRandomValues` for seed generation) — native in the browser and Node ≥ 20,
 * and provided on React Native by `src/polyfills.ts` — and does no I/O. The same function shipped
 * to web and mobile keeps the codes wire-compatible across platforms (Requirement C2). No private
 * identity-key material is referenced; the verification seed is its own secret.
 */

/** TOTP time step in seconds: the valid answer rotates every 60 s and cannot be replayed (§4.2). */
export const VERIFICATION_STEP_SECONDS = 60;

/** Number of decimal digits in a displayed verification code (a 6-digit TOTP, like an authenticator). */
export const VERIFICATION_CODE_DIGITS = 6;

/** Length in bytes of a verification seed (256-bit shared secret). */
export const VERIFICATION_SEED_BYTES = 32;

/** HKDF-style domain labels separating the normal and duress code streams from the one seed. */
const NORMAL_LABEL = 'chit-chat/identity-verify/normal/v1';
const DURESS_LABEL = 'chit-chat/identity-verify/duress/v1';

/** The classification of a submitted code against the current rotating window. */
export type CodeKind = 'normal' | 'duress' | 'invalid';

/** A pair of current rotating codes for one time step. */
export interface VerificationCodes {
  /** The ordinary 6-digit code shown when verifying normally. */
  normal: string;
  /**
   * The duress 6-digit code: it passes verification identically to {@link normal} (the requester
   * still sees a green badge) but the responder's app, recognising it, fires a silent alert to a
   * pre-configured trusted contact (§4.2, §4.3). Indistinguishable to an observer.
   */
  duress: string;
}

/**
 * The minimal WebCrypto surface this module needs: HMAC key import + signing. Declared locally
 * (rather than the DOM `SubtleCrypto` type) because the shared crypto package compiles with
 * `lib: ["ES2022"]` + `types: ["node"]` and no DOM lib; the browser, Node ≥ 20, and the React
 * Native polyfill all satisfy it at runtime.
 */
interface SubtleHmac {
  importKey(
    format: 'raw',
    keyData: Uint8Array,
    algorithm: { name: 'HMAC'; hash: 'SHA-1' | 'SHA-256' },
    extractable: boolean,
    keyUsages: ['sign'],
  ): Promise<CryptoKeyLike>;
  sign(algorithm: 'HMAC', key: CryptoKeyLike, data: Uint8Array): Promise<ArrayBuffer>;
}

/** Opaque handle to an imported key; the concrete type differs by host but is never inspected. */
type CryptoKeyLike = object;

/** Resolve the WebCrypto `subtle` surface, with a clear error if the host lacks it. */
function getSubtle(): SubtleHmac {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleHmac } }).crypto?.subtle;
  if (subtle === undefined) {
    throw new Error(
      'identity-verification: WebCrypto subtle is unavailable. The browser and Node ≥ 20 ' +
        'provide it natively; React Native must install it via src/polyfills.ts before use.',
    );
  }
  return subtle;
}

/** One HMAC over `data` with `key`, for the named hash, returned as raw bytes. */
async function hmac(hash: 'SHA-1' | 'SHA-256', key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const subtle = getSubtle();
  // Copy into standalone buffers so a subarray view never leaks extra bytes into the MAC.
  const keyBuf = new Uint8Array(key.length);
  keyBuf.set(key);
  const dataBuf = new Uint8Array(data.length);
  dataBuf.set(data);
  const cryptoKey = await subtle.importKey('raw', keyBuf, { name: 'HMAC', hash }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', cryptoKey, dataBuf));
}

/**
 * Generate a fresh 32-byte verification seed. Called once at verification setup; the caller
 * exchanges it over the E2E channel and stores it encrypted on device (§4.2). Uses the host CSPRNG
 * (`crypto.getRandomValues`), available natively in the browser/Node and via the RN polyfill.
 */
export function generateVerificationSeed(): Uint8Array {
  const out = new Uint8Array(VERIFICATION_SEED_BYTES);
  const cryptoObj = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (cryptoObj?.getRandomValues === undefined) {
    throw new Error(
      'identity-verification: crypto.getRandomValues is unavailable; cannot generate a seed.',
    );
  }
  cryptoObj.getRandomValues(out);
  return out;
}

/** Encode a seed to base64 for storage / E2E exchange. */
export function verificationSeedToBase64(seed: Uint8Array): string {
  return Buffer.from(seed).toString('base64');
}

/** Decode a base64 seed back to bytes. */
export function verificationSeedFromBase64(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/** Encode a counter as an 8-byte big-endian buffer (RFC 4226 §5.1 moving factor). */
function counterBytes(counter: number): Uint8Array {
  const buf = new Uint8Array(8);
  // Safe-integer counters (unix-seconds / 60) fit well within 2^53, so high dword is computed in JS.
  let value = Math.floor(counter);
  for (let i = 7; i >= 0; i -= 1) {
    buf[i] = value & 0xff;
    value = Math.floor(value / 256);
  }
  return buf;
}

/**
 * RFC 4226 HOTP over HMAC-SHA1: dynamic-truncate the MAC of `counter` under `key` to `digits`
 * decimal digits, zero-padded. Exposed (not just used internally) so it can be checked directly
 * against the RFC 4226 Appendix-D test vectors.
 */
export async function hotp(key: Uint8Array, counter: number, digits = VERIFICATION_CODE_DIGITS): Promise<string> {
  const mac = await hmac('SHA-1', key, counterBytes(counter)); // 20 bytes
  const offset = mac[mac.length - 1] & 0x0f;
  const binCode =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  const modulo = 10 ** digits;
  return (binCode % modulo).toString().padStart(digits, '0');
}

/** Derive the normal/duress HMAC sub-keys from the seed by domain separation. */
async function deriveSubKeys(seed: Uint8Array): Promise<{ normalKey: Uint8Array; duressKey: Uint8Array }> {
  const enc = new TextEncoder();
  const [normalKey, duressKey] = await Promise.all([
    hmac('SHA-256', seed, enc.encode(NORMAL_LABEL)),
    hmac('SHA-256', seed, enc.encode(DURESS_LABEL)),
  ]);
  return { normalKey, duressKey };
}

/** The TOTP counter (moving factor) for a wall-clock time in unix milliseconds. */
function counterForTime(nowMs: number, stepSeconds: number): number {
  return Math.floor(nowMs / 1000 / stepSeconds);
}

/**
 * Compute both rotating codes for the time step containing `nowMs`. Both peers, holding the same
 * seed, compute identical codes for the same step, so verification needs no server round-trip
 * (§4.2). The seed must be {@link VERIFICATION_SEED_BYTES} bytes.
 */
export async function currentVerificationCodes(
  seed: Uint8Array,
  nowMs: number,
  stepSeconds: number = VERIFICATION_STEP_SECONDS,
): Promise<VerificationCodes> {
  if (seed.length === 0) {
    throw new Error('identity-verification: seed must be non-empty');
  }
  const { normalKey, duressKey } = await deriveSubKeys(seed);
  const counter = counterForTime(nowMs, stepSeconds);
  const [normal, duress] = await Promise.all([hotp(normalKey, counter), hotp(duressKey, counter)]);
  return { normal, duress };
}

/** Options for {@link classifyVerificationCode}. */
export interface ClassifyOptions {
  /**
   * Number of adjacent time steps (on each side of the current one) also accepted, to tolerate
   * clock skew and the moment a code rotates while being read out (RFC 6238 §5.2 resync window).
   * Defaults to 1 (±60 s).
   */
  skewSteps?: number;
  /** Time step in seconds; defaults to {@link VERIFICATION_STEP_SECONDS}. */
  stepSeconds?: number;
}

/**
 * Classify a submitted `code` against the rotating window around `nowMs` (§4.3):
 *   - `'duress'`  — matches the duress stream in the window (fire the silent alert);
 *   - `'normal'`  — matches the normal stream in the window (a plain pass);
 *   - `'invalid'` — matches neither (an `Unverified` result).
 *
 * Duress takes priority on the astronomically rare step where both 6-digit streams coincide, so a
 * genuine duress answer is never silently downgraded to a normal pass — the safety of the person
 * under duress is favoured over avoiding a (silent, low-harm) false alert.
 *
 * Constant-time comparison is intentionally NOT required here: the codes rotate every 60 s and an
 * attacker submitting guesses is the threat the rotation+window already bounds, not a timing
 * side-channel on a local string compare.
 */
export async function classifyVerificationCode(
  seed: Uint8Array,
  code: string,
  nowMs: number,
  options: ClassifyOptions = {},
): Promise<CodeKind> {
  const stepSeconds = options.stepSeconds ?? VERIFICATION_STEP_SECONDS;
  const skewSteps = Math.max(0, Math.floor(options.skewSteps ?? 1));
  const normalized = code.trim();
  if (!/^\d+$/.test(normalized)) {
    return 'invalid';
  }
  const { normalKey, duressKey } = await deriveSubKeys(seed);
  const baseCounter = counterForTime(nowMs, stepSeconds);

  let matchesNormal = false;
  let matchesDuress = false;
  for (let delta = -skewSteps; delta <= skewSteps; delta += 1) {
    const counter = baseCounter + delta;
    // eslint-disable-next-line no-await-in-loop -- small fixed window (≤ 2*skew+1), clarity over micro-opt
    const [normal, duress] = await Promise.all([hotp(normalKey, counter), hotp(duressKey, counter)]);
    if (normal === normalized) {
      matchesNormal = true;
    }
    if (duress === normalized) {
      matchesDuress = true;
    }
  }
  if (matchesDuress) {
    return 'duress';
  }
  return matchesNormal ? 'normal' : 'invalid';
}

/**
 * Milliseconds until the current code rotates, for a UI countdown. Always in `(0, step*1000]`.
 */
export function msUntilNextCode(nowMs: number, stepSeconds: number = VERIFICATION_STEP_SECONDS): number {
  const periodMs = stepSeconds * 1000;
  const remainder = ((nowMs % periodMs) + periodMs) % periodMs;
  return periodMs - remainder;
}
