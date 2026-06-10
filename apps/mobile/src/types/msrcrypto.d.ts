/**
 * Ambient declaration for the pure-JS WebCrypto fallback bundled inside
 * `@privacyresearch/libsignal-protocol-typescript`. The package ships no types for this
 * internal file; we import it only to feed its `subtle` implementation to `setWebCrypto`
 * on React Native (see `src/polyfills.ts`).
 */
declare module '@privacyresearch/libsignal-protocol-typescript/lib/msrcrypto' {
  const msrcrypto: {
    subtle: SubtleCrypto;
    getRandomValues: <T extends ArrayBufferView | null>(array: T) => T;
  };
  export default msrcrypto;
}
