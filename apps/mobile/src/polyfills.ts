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
const globalScope = globalThis as unknown as { Buffer?: typeof Buffer; crypto?: Crypto };
if (typeof globalScope.Buffer === 'undefined') {
  globalScope.Buffer = Buffer;
}

// 2. WebCrypto: msrcrypto for `subtle`, native CSPRNG for `getRandomValues`. Build a hybrid
// so the actually-random bytes come from the platform CSPRNG, not msrcrypto's JS PRNG.
const nativeCrypto = globalScope.crypto;
setWebCrypto({
  subtle: (msrcrypto as { subtle: SubtleCrypto }).subtle,
  getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
    if (array !== null && nativeCrypto?.getRandomValues !== undefined) {
      nativeCrypto.getRandomValues(array as unknown as ArrayBufferView);
    }
    return array;
  },
} as unknown as Crypto);
