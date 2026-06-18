/**
 * `@chat-app/crypto` — per-attachment symmetric encryption (Phase 2, Requirement 7).
 *
 * Media/attachments are encrypted CLIENT-SIDE with a fresh per-attachment key before they are
 * uploaded to the blob store, so the server only ever holds ciphertext (Req 7.1). The key is
 * delivered to the recipient INSIDE the end-to-end message payload (the `attachment` content
 * payload), never to the blob store (Req 7.2) — so possession of the blob alone reveals nothing.
 *
 * Construction: AES-256-GCM with a random 256-bit key and a random 96-bit IV. GCM is
 * authenticated, so any tampering with the stored ciphertext (or a wrong key) makes
 * {@link decryptAttachment} reject rather than return corrupt bytes. Each attachment gets its own
 * key + IV, so a key compromise never extends beyond a single file.
 *
 * Platform-agnostic and pure: depends only on WebCrypto (`crypto.subtle` + `getRandomValues`,
 * native in browsers and Node ≥ 20, provided on React Native by `src/polyfills.ts`). No I/O —
 * the caller owns the actual upload/download (Req 7.3).
 */

/** AES key length in bytes (AES-256). */
const KEY_LENGTH = 32;
/** GCM nonce length in bytes (96-bit, the standard/recommended IV size for AES-GCM). */
const IV_LENGTH = 12;

/**
 * The minimal WebCrypto surface this module needs. Declared locally (rather than referencing the
 * DOM `SubtleCrypto` type) because the shared crypto package compiles with `lib: ["ES2022"]` +
 * `types: ["node"]` and no DOM lib; the browser, Node ≥ 20, and the RN polyfill satisfy it.
 */
interface SubtleLike {
  importKey(
    format: 'raw',
    keyData: Uint8Array,
    algorithm: { name: 'AES-GCM' },
    extractable: boolean,
    keyUsages: Array<'encrypt' | 'decrypt'>,
  ): Promise<unknown>;
  encrypt(algorithm: { name: 'AES-GCM'; iv: Uint8Array }, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
  decrypt(algorithm: { name: 'AES-GCM'; iv: Uint8Array }, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
}

interface CryptoLike {
  subtle: SubtleLike;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

/** A freshly-encrypted attachment: ciphertext for the blob store, key+iv for the E2E payload. */
export interface EncryptedAttachment {
  /** AES-GCM ciphertext (with the appended auth tag) — this is what gets uploaded (Req 7.1). */
  ciphertext: Uint8Array;
  /** The 32-byte content-encryption key. Rides in the E2E payload ONLY, never to the store (7.2). */
  key: Uint8Array;
  /** The 12-byte GCM nonce. Travels with the key in the E2E payload. */
  iv: Uint8Array;
}

/** Inputs needed to decrypt a downloaded attachment. */
export interface AttachmentCipher {
  /** The downloaded AES-GCM ciphertext (with auth tag). */
  ciphertext: Uint8Array;
  /** The 32-byte content-encryption key from the E2E payload. */
  key: Uint8Array;
  /** The 12-byte GCM nonce from the E2E payload. */
  iv: Uint8Array;
}

/** Resolve the WebCrypto surface, with a clear error if the host lacks it. */
function getCrypto(): CryptoLike {
  const c = (globalThis as { crypto?: CryptoLike }).crypto;
  if (c === undefined || c.subtle === undefined || typeof c.getRandomValues !== 'function') {
    throw new Error(
      'attachment-crypto: WebCrypto is unavailable. The browser and Node ≥ 20 provide it ' +
        'natively; React Native must install it via src/polyfills.ts before use.',
    );
  }
  return c;
}

/**
 * Encrypt `plaintext` (the raw attachment bytes) under a fresh random AES-256-GCM key + IV.
 * Returns the ciphertext to upload plus the key+iv to place in the E2E payload (Req 7.1, 7.2).
 */
export async function encryptAttachment(plaintext: Uint8Array): Promise<EncryptedAttachment> {
  const c = getCrypto();
  const key = c.getRandomValues(new Uint8Array(KEY_LENGTH));
  const iv = c.getRandomValues(new Uint8Array(IV_LENGTH));
  const cryptoKey = await c.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(await c.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, plaintext));
  return { ciphertext, key, iv };
}

/**
 * Decrypt a downloaded attachment with the key+iv carried in the E2E payload. Rejects (rather
 * than returning corrupt bytes) if the ciphertext was tampered with or the key/iv is wrong — GCM
 * verifies the authentication tag (Req 7 integrity).
 *
 * @throws if the key/iv length is wrong, WebCrypto is unavailable, or authentication fails.
 */
export async function decryptAttachment(input: AttachmentCipher): Promise<Uint8Array> {
  if (input.key.length !== KEY_LENGTH) {
    throw new Error(`attachment-crypto: key must be ${KEY_LENGTH} bytes`);
  }
  if (input.iv.length !== IV_LENGTH) {
    throw new Error(`attachment-crypto: iv must be ${IV_LENGTH} bytes`);
  }
  const c = getCrypto();
  const cryptoKey = await c.subtle.importKey('raw', input.key, { name: 'AES-GCM' }, false, ['decrypt']);
  const plaintext = await c.subtle.decrypt({ name: 'AES-GCM', iv: input.iv }, cryptoKey, input.ciphertext);
  return new Uint8Array(plaintext);
}
