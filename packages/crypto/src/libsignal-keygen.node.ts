/**
 * Node-only libsignal key-gen adapter (real `@signalapp/libsignal-client`).
 *
 * Deliberately kept OUT of the package entry (`index.ts`): it lazily loads the native
 * `@signalapp/libsignal-client` through a non-literal specifier, which `tsc` emits as a
 * dynamic `require(var)`. The React Native bundler (Metro) rejects dynamic requires, so
 * exporting this from the shared index would break the mobile bundle. Node consumers
 * (the backend / tooling) import THIS module directly; web and mobile bundles never
 * reference it, and the shared `IdentityManager` keeps using the injected
 * {@link LibsignalKeyGen} port.
 */

import type { GeneratedKeyPair, LibsignalKeyGen } from './identity-manager';

/**
 * Minimal view of the `@signalapp/libsignal-client` surface the adapter uses. Kept
 * local so this module type-checks without the native bindings present; the module is
 * loaded lazily at runtime via a non-literal specifier.
 */
interface LibsignalPublicKey {
  serialize(): Buffer;
}
interface LibsignalPrivateKey {
  serialize(): Buffer;
  getPublicKey(): LibsignalPublicKey;
  sign(message: Buffer): Buffer;
}
interface LibsignalIdentityKeyPair {
  readonly publicKey: LibsignalPublicKey;
  readonly privateKey: LibsignalPrivateKey;
}
interface LibsignalModule {
  IdentityKeyPair: { generate(): LibsignalIdentityKeyPair };
  PrivateKey: {
    generate(): LibsignalPrivateKey;
    deserialize(bytes: Buffer): LibsignalPrivateKey;
  };
}

/**
 * Build a {@link LibsignalKeyGen} backed by the real `@signalapp/libsignal-client`
 * library. The module is imported lazily through a variable specifier so this file
 * type-checks even where the native bindings cannot be resolved at build time
 * (resolution happens on first use, in a Node runtime).
 *
 * NOTE: libsignal does not expose a registration-id helper, so a registration id is
 * drawn uniformly from the documented 1..16380 range here (always >= 1, Requirement
 * 2.3). The `IdentityManager` re-validates the >= 1 invariant regardless.
 */
export function createLibsignalKeyGen(): LibsignalKeyGen {
  // Indirect specifier keeps the static type-checker from requiring the (optional,
  // platform-native) module to be resolvable in this package.
  const moduleName = '@signalapp/libsignal-client';
  const load = async (): Promise<LibsignalModule> =>
    (await import(moduleName)) as unknown as LibsignalModule;

  return {
    async generateIdentityKeyPair(): Promise<GeneratedKeyPair> {
      const signal = await load();
      const pair = signal.IdentityKeyPair.generate();
      return {
        publicKey: new Uint8Array(pair.publicKey.serialize()),
        privateKey: new Uint8Array(pair.privateKey.serialize()),
      };
    },

    async generateRegistrationId(): Promise<number> {
      // Uniform in [1, 16380]; libsignal exposes no dedicated helper.
      return 1 + Math.floor(Math.random() * 16380);
    },

    async generatePreKeyPair(): Promise<GeneratedKeyPair> {
      const signal = await load();
      const priv = signal.PrivateKey.generate();
      return {
        publicKey: new Uint8Array(priv.getPublicKey().serialize()),
        privateKey: new Uint8Array(priv.serialize()),
      };
    },

    async signWithIdentity(
      identityPrivateKey: Uint8Array,
      message: Uint8Array,
    ): Promise<Uint8Array> {
      const signal = await load();
      const priv = signal.PrivateKey.deserialize(Buffer.from(identityPrivateKey));
      return new Uint8Array(priv.sign(Buffer.from(message)));
    },
  };
}
