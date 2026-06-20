import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ShadowSecretStore,
  deriveShadowThreadId,
  matchAlias,
  type AliasEntry,
  type ShadowThreadRef,
} from '@chat-app/crypto';

import type { PersistentVault } from '../crypto/persistent-store';
import { createVaultShadowSecretPersistence } from './shadow-secret-persistence';

/**
 * Mobile Shadow-Chat CREATION regression test (bugfix: "Could not create the shadow chat").
 *
 * Reproduces the on-device-only defect that the green Node CI suite never exercised: the shadow
 * creation path (`provisionShadowContext` → `ShadowSecretStore.bindAlias` → `deriveShadowThreadId` /
 * `hashAlias`) drives `crypto.subtle` HMAC, and the React Native WebCrypto (msrcrypto) REJECTS the
 * string-form HMAC algorithm parameters that Node/browser WebCrypto tolerate. The prior
 * `shadow-chat.ts` used the string form, so `bindAlias` threw on-device and the create sheet showed
 * its generic failure, while every Node test passed.
 *
 * This test installs a `subtle` that mirrors msrcrypto's STRICTNESS (rejecting the string forms,
 * delegating the object forms to Node's real WebCrypto), then runs the REAL
 * provision→bind→resolve path through `createVaultShadowSecretPersistence` over a faithful
 * single-encrypted-blob fake vault + `ShadowSecretStore`. It fails against the old string-form code
 * and passes against the object-form fix, so the device-only regression is now guarded in CI.
 */

// Node's real WebCrypto, captured BEFORE the strict shim is installed (used as the delegate).
const realCrypto = globalThis.crypto;
const realSubtle = realCrypto.subtle;

/**
 * A msrcrypto-faithful `subtle`: it throws an "algorithm" error for the STRING-form HMAC import
 * (`hash: 'SHA-256'`) and the STRING-form `sign` algorithm (`'HMAC'`) — exactly the forms the
 * on-device React Native WebCrypto rejects (see apps/mobile/src/crypto/crypto-box.ts) — and
 * delegates the object forms to Node's real subtle so a correct caller still computes a real HMAC.
 */
const msrcryptoFaithfulSubtle = {
  importKey(
    format: 'raw',
    keyData: Uint8Array,
    algorithm: { name: string; hash?: unknown },
    extractable: boolean,
    usages: KeyUsage[],
  ): Promise<CryptoKey> {
    if (algorithm.name === 'HMAC' && (typeof algorithm.hash !== 'object' || algorithm.hash === null)) {
      throw new Error('algorithm: msrcrypto requires the HMAC hash in object form { name }');
    }
    return realSubtle.importKey(
      format,
      keyData as unknown as BufferSource,
      algorithm as unknown as HmacImportParams,
      extractable,
      usages,
    );
  },
  sign(algorithm: unknown, key: CryptoKey, data: Uint8Array): Promise<ArrayBuffer> {
    if (typeof algorithm === 'string') {
      throw new Error('algorithm: msrcrypto requires the HMAC sign algorithm in object form');
    }
    return realSubtle.sign(algorithm as AlgorithmIdentifier, key, data as unknown as BufferSource);
  },
} as unknown as SubtleCrypto;

/** Run `body` with the msrcrypto-faithful `subtle` installed on the global `crypto`, then restore. */
async function withDeviceFaithfulCrypto<T>(body: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      subtle: msrcryptoFaithfulSubtle,
      getRandomValues: <A extends ArrayBufferView | null>(array: A): A =>
        array === null ? array : (realCrypto.getRandomValues(array as ArrayBufferView) as unknown as A),
    },
  });
  try {
    return await body();
  } finally {
    if (original !== undefined) {
      Object.defineProperty(globalThis, 'crypto', original);
    }
  }
}

/** The committed slice of the vault document the shadow adapter touches. */
interface ShadowDocShape {
  shadowSecrets?: {
    masterSecret?: string;
    aliasKey?: string;
    aliasEntries?: Array<{ aliasHash: string; ref: ShadowThreadRef }>;
  };
}

/**
 * A faithful encrypted {@link PersistentVault}: the committed document is ONE serialized blob (the
 * production AES blob), `mutate` hydrates a working copy, applies, re-serialises and commits, and
 * `read` always deserialises the committed blob. Modelling the real single-blob store proves the
 * `shadowSecrets` section round-trips end to end.
 */
class FakeEncryptedVault {
  private committed = JSON.stringify({} as ShadowDocShape);

  async read<T>(fn: (doc: ShadowDocShape) => T): Promise<T> {
    return fn(JSON.parse(this.committed) as ShadowDocShape);
  }

  async mutate<T>(fn: (doc: ShadowDocShape) => T): Promise<T> {
    const working = JSON.parse(this.committed) as ShadowDocShape;
    const result = fn(working);
    this.committed = JSON.stringify(working);
    return result;
  }

  release(): void {}
  async wipe(): Promise<void> {
    this.committed = JSON.stringify({});
  }
}

const asVault = (fake: FakeEncryptedVault): PersistentVault => fake as unknown as PersistentVault;

/** Mirror the controller's `provisionShadowContext`: mint 32-byte CSPRNG secrets if absent. */
async function provision(persistence: ReturnType<typeof createVaultShadowSecretPersistence>): Promise<void> {
  const [master, aliasKey] = await Promise.all([
    persistence.loadMasterSecret(),
    persistence.loadAliasKey(),
  ]);
  if (master === null || master.length === 0) {
    await persistence.saveMasterSecret(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  }
  if (aliasKey === null || aliasKey.length === 0) {
    await persistence.saveAliasKey(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  }
}

const PEER_UID = 'peer-bob-uid';
const MY_UID = 'me-alice-uid';

test('provision → bindAlias → matchAlias succeeds under the device-faithful WebCrypto (bugfix)', async () => {
  await withDeviceFaithfulCrypto(async () => {
    const fake = new FakeEncryptedVault();
    const persistence = createVaultShadowSecretPersistence(asVault(fake));
    const store = new ShadowSecretStore(persistence);

    // 1) Provision the device-local secrets (the controller step that precedes binding).
    await provision(persistence);

    // 2) Bind the alias-discriminated shadow thread. With the old string-form HMAC this throws
    //    under the device-faithful subtle (the exact on-device failure); the fix makes it succeed.
    const ref = await store.bindAlias('real', '/chat1', PEER_UID, MY_UID);
    assert.notEqual(ref, null, 'bindAlias must return a non-null ref (the prior failure mode)');
    assert.equal(ref?.peerUid, PEER_UID);
    assert.match(ref?.threadId ?? '', /^[0-9a-f]{64}$/, 'threadId is 64-char lowercase hex');

    // 3) The bound threadId equals the independent symmetric derivation for the same inputs.
    const master = await persistence.loadMasterSecret();
    assert.notEqual(master, null);
    const expected = await deriveShadowThreadId(master as Uint8Array, MY_UID, PEER_UID, '/chat1');
    assert.equal(ref?.threadId, expected, 'bindAlias derives the alias-discriminated threadId');

    // 4) The alias now RESOLVES via the same hash-only matcher the search bar uses.
    const aliasKey = await persistence.loadAliasKey();
    const entries = await persistence.loadAliasEntries();
    const resolved = await matchAlias('/chat1', entries, aliasKey as Uint8Array);
    assert.notEqual(resolved, null, 'the bound alias must resolve');
    assert.equal(resolved?.threadId, ref?.threadId);

    // A wrong/non-existent alias resolves to null (indistinguishable miss).
    assert.equal(await matchAlias('/nope', entries, aliasKey as Uint8Array), null);
  });
});

test('the vault document round-trips the shadowSecrets section across a relaunch', async () => {
  await withDeviceFaithfulCrypto(async () => {
    const fake = new FakeEncryptedVault();
    const persistence = createVaultShadowSecretPersistence(asVault(fake));
    const store = new ShadowSecretStore(persistence);
    await provision(persistence);
    const ref = (await store.bindAlias('real', '/chat1', PEER_UID, MY_UID)) as ShadowThreadRef;

    // A FRESH persistence over the SAME committed blob simulates an app relaunch.
    const fresh = createVaultShadowSecretPersistence(asVault(fake));
    assert.notEqual(await fresh.loadMasterSecret(), null, 'master secret survives the relaunch');
    assert.notEqual(await fresh.loadAliasKey(), null, 'alias key survives the relaunch');
    const entries: ReadonlyArray<AliasEntry<ShadowThreadRef>> = await fresh.loadAliasEntries();
    assert.equal(entries.length, 1, 'the bound alias entry survives the relaunch');
    assert.equal(entries[0].ref.threadId, ref.threadId);
    assert.equal(entries[0].ref.peerUid, PEER_UID);
  });
});
