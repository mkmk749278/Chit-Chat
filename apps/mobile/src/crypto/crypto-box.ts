/**
 * `apps/mobile` — authenticated symmetric encryption for the on-device vault.
 *
 * Backs the {@link CryptoBox} port used by the persistent store (see `persistent-store.ts`)
 * with AES-256-CBC + HMAC-SHA256 in an **encrypt-then-MAC** construction:
 *
 *   ct  = AES-256-CBC(encKey, iv, utf8(plaintext))
 *   tag = HMAC-SHA256(macKey, iv ‖ ct)
 *   blob = "v1:" ‖ base64(iv ‖ ct ‖ tag)
 *
 * The 64-byte data-encryption key is split into a 32-byte AES key and a 32-byte MAC key.
 * Decryption verifies the tag (in constant time, via WebCrypto `verify`) BEFORE decrypting,
 * so a tampered or truncated blob is rejected rather than fed to the cipher.
 *
 * AES-CBC and HMAC-SHA256 are deliberately chosen over AES-GCM: they are the exact
 * primitives the Double Ratchet already drives through the same polyfilled WebCrypto
 * (`docs/messaging-runtime-binding.md`, `src/polyfills.ts`), so the vault relies only on
 * code paths already proven to work in the Hermes runtime — no new crypto surface.
 *
 * The construction is platform-agnostic: it depends only on an injected `SubtleCrypto`
 * and a CSPRNG, so it round-trips identically under Node's WebCrypto (tests) and the
 * app's msrcrypto-backed `subtle` (device).
 */

import { Buffer } from 'buffer';

/** Authenticated encrypt/decrypt of a UTF-8 string under a raw byte key. */
export interface CryptoBox {
  /** Encrypt `plaintext` under `key` (>= 64 bytes); returns a self-describing blob string. */
  encrypt(plaintext: string, key: Uint8Array): Promise<string>;
  /**
   * Decrypt a blob produced by {@link CryptoBox.encrypt} under the same `key`.
   * @throws if the key is wrong, the blob is malformed, or the MAC does not verify.
   */
  decrypt(blob: string, key: Uint8Array): Promise<string>;
}

/** The narrow WebCrypto surface the box needs; satisfied by Node and msrcrypto alike. */
export interface CryptoBoxDeps {
  subtle: SubtleCrypto;
  getRandomValues: <T extends ArrayBufferView>(array: T) => T;
}

/** Version tag so the on-disk format can evolve without ambiguous decode. */
const FORMAT_PREFIX = 'v1:';
/** AES-CBC block size / IV length in bytes. */
const IV_LENGTH = 16;
/** HMAC-SHA256 tag length in bytes. */
const TAG_LENGTH = 32;
/** AES-256 key length in bytes (first half of the DEK). */
const ENC_KEY_LENGTH = 32;
/** Required minimum DEK length: 32-byte AES key + 32-byte MAC key. */
export const REQUIRED_KEY_LENGTH = ENC_KEY_LENGTH + TAG_LENGTH;

const utf8Encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const utf8Decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const fromBase64 = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'base64'));

/** Concatenate byte arrays into a single buffer. */
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A view's underlying bytes as a standalone `ArrayBuffer` (WebCrypto wants a buffer). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Constant-time byte comparison; both inputs are MAC tags of equal length. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
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
 * Build a {@link CryptoBox} over the injected WebCrypto. The same factory is used on-device
 * (msrcrypto `subtle` + native CSPRNG) and in tests (Node WebCrypto).
 */
export function createCryptoBox(deps: CryptoBoxDeps): CryptoBox {
  const { subtle, getRandomValues } = deps;

  const splitKey = (key: Uint8Array): { encKey: Uint8Array; macKey: Uint8Array } => {
    if (key.length < REQUIRED_KEY_LENGTH) {
      throw new Error(`CryptoBox: key must be at least ${REQUIRED_KEY_LENGTH} bytes`);
    }
    return { encKey: key.subarray(0, ENC_KEY_LENGTH), macKey: key.subarray(ENC_KEY_LENGTH, REQUIRED_KEY_LENGTH) };
  };

  const importAesKey = (raw: Uint8Array): Promise<CryptoKey> =>
    subtle.importKey('raw', toArrayBuffer(raw), { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);

  const importMacKey = (raw: Uint8Array): Promise<CryptoKey> =>
    subtle.importKey('raw', toArrayBuffer(raw), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
      'verify',
    ]);

  return {
    async encrypt(plaintext: string, key: Uint8Array): Promise<string> {
      const { encKey, macKey } = splitKey(key);
      const iv = getRandomValues(new Uint8Array(IV_LENGTH));
      const aesKey = await importAesKey(encKey);
      const ciphertext = new Uint8Array(
        await subtle.encrypt({ name: 'AES-CBC', iv: toArrayBuffer(iv) }, aesKey, toArrayBuffer(utf8Encode(plaintext))),
      );
      const macKeyHandle = await importMacKey(macKey);
      const signed = concatBytes(iv, ciphertext);
      const tag = new Uint8Array(await subtle.sign('HMAC', macKeyHandle, toArrayBuffer(signed)));
      return FORMAT_PREFIX + toBase64(concatBytes(iv, ciphertext, tag));
    },

    async decrypt(blob: string, key: Uint8Array): Promise<string> {
      if (!blob.startsWith(FORMAT_PREFIX)) {
        throw new Error('CryptoBox: unrecognized blob format');
      }
      const bytes = fromBase64(blob.slice(FORMAT_PREFIX.length));
      if (bytes.length < IV_LENGTH + TAG_LENGTH) {
        throw new Error('CryptoBox: blob too short');
      }
      const iv = bytes.subarray(0, IV_LENGTH);
      const tag = bytes.subarray(bytes.length - TAG_LENGTH);
      const ciphertext = bytes.subarray(IV_LENGTH, bytes.length - TAG_LENGTH);

      const { encKey, macKey } = splitKey(key);
      const macKeyHandle = await importMacKey(macKey);
      const signed = concatBytes(iv, ciphertext);
      // Recompute the tag with `sign` and compare in constant time rather than using
      // `subtle.verify` — `sign` is the HMAC path the Double Ratchet already exercises in
      // the on-device WebCrypto, so the vault depends on no additional crypto surface.
      const expected = new Uint8Array(await subtle.sign('HMAC', macKeyHandle, toArrayBuffer(signed)));
      if (!constantTimeEqual(expected, tag)) {
        throw new Error('CryptoBox: authentication failed (wrong key or tampered data)');
      }

      const aesKey = await importAesKey(encKey);
      const plaintext = new Uint8Array(
        await subtle.decrypt({ name: 'AES-CBC', iv: toArrayBuffer(iv) }, aesKey, toArrayBuffer(ciphertext)),
      );
      return utf8Decode(plaintext);
    },
  };
}
