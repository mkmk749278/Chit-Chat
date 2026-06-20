/**
 * Runtime polyfills for the shared crypto core on React Native (Hermes).
 *
 * MUST be imported FIRST, before any `@chat-app/crypto` code runs (see `index.ts`), because
 * the pure-TS Signal engine and the shared core assume a browser/Node-like environment that
 * Hermes does not fully provide:
 *
 *  1. `crypto.getRandomValues` — `react-native-get-random-values` installs a CSPRNG-backed
 *     implementation on `global.crypto` (Hermes has none).
 *  2. `crypto.subtle` — Hermes has no WebCrypto SubtleCrypto. The Signal library
 *     (`@privacyresearch/libsignal-protocol-typescript`) needs AES-CBC / HMAC-SHA256 /
 *     SHA-512 for the Double Ratchet. We inject a WebCrypto via the library's
 *     `setWebCrypto(...)`: its bundled pure-JS `msrcrypto` provides `subtle`, while
 *     randomness is delegated to the native CSPRNG from step 1 (never msrcrypto's PRNG).
 *     This keeps the engine free of any native crypto module (no extra build/sign risk),
 *     matching the runtime-binding decision (docs/messaging-runtime-binding.md). Verified in
 *     Node against the same msrcrypto build.
 *  3. `Buffer` — the shared core uses `Buffer` for base64 at the wire boundary; Hermes has
 *     no global `Buffer`, so install the `buffer` package's implementation.
 */

// 1. CSPRNG: defines global.crypto.getRandomValues. Import for its side effect, first.
import 'react-native-get-random-values';

import { Buffer } from 'buffer';
import { setWebCrypto } from '@privacyresearch/libsignal-protocol-typescript';
// The library ships a pure-JS WebCrypto (`msrcrypto`); import the file directly (the
// package declares no `exports` map, so Metro resolves this subpath by file path).
// eslint-disable-next-line @typescript-eslint/no-var-requires
import msrcrypto from '@privacyresearch/libsignal-protocol-typescript/lib/msrcrypto';

// 3. Buffer global for base64 at the wire boundary.
const globalScope = globalThis as unknown as {
  Buffer?: typeof Buffer;
  crypto?: Crypto;
  TextEncoder?: unknown;
  TextDecoder?: unknown;
};
if (typeof globalScope.Buffer === 'undefined') {
  globalScope.Buffer = Buffer;
}

// 4. TextEncoder / TextDecoder — Hermes provides neither, but the pure-TS libsignal engine
// uses them (UTF-8) when encrypting/decrypting message text. Back them with the Buffer
// global above (UTF-8 is exactly what libsignal needs); no extra native module.
if (typeof globalScope.TextEncoder === 'undefined') {
  globalScope.TextEncoder = class {
    readonly encoding = 'utf-8';
    encode(input = ''): Uint8Array {
      return new Uint8Array(Buffer.from(input, 'utf-8'));
    }
    encodeInto(source: string, destination: Uint8Array): { read: number; written: number } {
      const encoded = this.encode(source);
      const written = Math.min(encoded.length, destination.length);
      destination.set(encoded.subarray(0, written));
      return { read: source.length, written };
    }
  };
}
if (typeof globalScope.TextDecoder === 'undefined') {
  globalScope.TextDecoder = class {
    readonly encoding: string;
    constructor(encoding = 'utf-8') {
      this.encoding = encoding;
    }
    decode(input?: ArrayBuffer | ArrayBufferView): string {
      if (input === undefined) {
        return '';
      }
      const buf = ArrayBuffer.isView(input)
        ? Buffer.from(input.buffer, input.byteOffset, input.byteLength)
        : Buffer.from(input as ArrayBuffer);
      return buf.toString('utf-8');
    }
  };
}

// 2. WebCrypto: msrcrypto for `subtle`, native CSPRNG for `getRandomValues`. Build a hybrid
// so the actually-random bytes come from the platform CSPRNG, not msrcrypto's JS PRNG.
const nativeCrypto = globalScope.crypto;
const subtle = (msrcrypto as { subtle: SubtleCrypto }).subtle;
setWebCrypto({
  subtle,
  getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
    if (array !== null && nativeCrypto?.getRandomValues !== undefined) {
      nativeCrypto.getRandomValues(array as unknown as ArrayBufferView);
    }
    return array;
  },
} as unknown as Crypto);

// Also expose `subtle` on the global crypto object so the encrypted on-device store
// (src/crypto/native-vault.ts → CryptoBox) can use AES-CBC/HMAC. Hermes' getRandomValues
// (from step 1) stays the source of randomness; we only add the missing `subtle`.
if (nativeCrypto !== undefined && (nativeCrypto as { subtle?: SubtleCrypto }).subtle === undefined) {
  Object.defineProperty(nativeCrypto, 'subtle', { value: subtle, configurable: true, writable: false });
}

// 5. Off-thread PBKDF2 (P1 freeze fix — ui-modernization-and-setup-fix, Requirements 1.2, 1.5, 4.8).
// The shared `secret-hash` core derives a password verifier with PBKDF2-HMAC-SHA256 at 210k
// iterations. Left on the msrcrypto `subtle` wired above, that derivation runs synchronously on
// Hermes' single JS thread and freezes the UI during every PIN / decoy / hide-chat / unlock /
// reveal operation. Bind the core's injected Pbkdf2Provider to the native, JSI-backed adapter so the
// derivation runs on a background thread instead. Only the encrypted vault's small AES-CBC/HMAC work
// stays on msrcrypto.
//
// If the native module is missing at runtime (e.g. Expo Go without a dev-client), keep the secure
// WebCrypto default: it still derives at the FULL 210000 iterations (no parameter is ever lowered) —
// only speed degrades, and the async busy-UI keeps the screens responsive while it resolves.
try {
  // Imported lazily and guarded so a missing native module degrades gracefully rather than crashing
  // app boot before the WebCrypto fallback can take over.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { setPbkdf2Provider } = require('@chat-app/crypto') as typeof import('@chat-app/crypto');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { nativePbkdf2Provider } = require('./crypto/pbkdf2-native') as typeof import('./crypto/pbkdf2-native');
  setPbkdf2Provider(nativePbkdf2Provider);
} catch {
  // Native module unavailable: retain the WebCrypto default at 210000 iterations (never weakened).
}
