import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import type { AliasEntry } from './shadow-chat';
import {
  ShadowSecretStore,
  type ShadowSecretPersistence,
  type ShadowThreadRef,
} from './shadow-secret-store';

/**
 * Property test for the {@link ShadowSecretStore} (Shadow Chat, design Component 6; task 7.3).
 *
 * Feature: shadow-chat. Validates design **Correctness Property 10 (decoy mode reveals nothing)**:
 * for ANY stored state (arbitrary master secret, alias key, and alias-entry set) and ANY mode that
 * is `decoy` or `null`, `getShadowContext` returns `null` and `listAliasEntries` returns `[]`, so no
 * thread id can be derived and no alias resolves — and the decoy and null modes are observationally
 * identical to each other (Requirements 8.2, 8.3, 8.6). Runs >=100 randomised iterations and reports
 * fast-check's counterexample on failure.
 */

/** A non-real mode: the store must reveal nothing in either of these. */
const nonRealModeArb: fc.Arbitrary<'decoy' | null> = fc.constantFrom('decoy' as const, null);

/** Arbitrary non-empty secret bytes (master secret / alias key). */
const secretArb = fc.uint8Array({ minLength: 1, maxLength: 64 });

/** Arbitrary opaque alias entries (hash + ref); the contents are irrelevant to Property 10. */
const entriesArb: fc.Arbitrary<AliasEntry<ShadowThreadRef>[]> = fc.array(
  fc.record({
    aliasHash: fc.hexaString({ minLength: 64, maxLength: 64 }),
    ref: fc.record({ peerUid: fc.string({ minLength: 1 }), threadId: fc.hexaString({ minLength: 64, maxLength: 64 }) }),
  }),
  { maxLength: 16 },
);

/** Build a fully-provisioned in-memory persistence from arbitrary state. */
function persistenceOf(
  master: Uint8Array,
  aliasKey: Uint8Array,
  entries: ReadonlyArray<AliasEntry<ShadowThreadRef>>,
): ShadowSecretPersistence {
  return {
    async loadMasterSecret() {
      return master;
    },
    async saveMasterSecret() {},
    async loadAliasKey() {
      return aliasKey;
    },
    async saveAliasKey() {},
    async loadAliasEntries() {
      return entries.slice();
    },
    async saveAliasEntry() {},
  };
}

test('Property 10: decoy/null mode releases no context and no entries, for any stored state', async () => {
  // Feature: shadow-chat, Correctness Property 10 (decoy reveals nothing).
  await fc.assert(
    fc.asyncProperty(secretArb, secretArb, entriesArb, nonRealModeArb, async (master, aliasKey, entries, mode) => {
      const store = new ShadowSecretStore(persistenceOf(master, aliasKey, entries));
      assert.equal(await store.getShadowContext(mode), null, 'non-real mode must release no context');
      assert.deepEqual(await store.listAliasEntries(mode), [], 'non-real mode must release no entries');
    }),
    { numRuns: 200 },
  );
});

test('Property 10: decoy and null are observationally identical, for any stored state', async () => {
  // Feature: shadow-chat, Correctness Property 10 (decoy and null indistinguishable).
  await fc.assert(
    fc.asyncProperty(secretArb, secretArb, entriesArb, async (master, aliasKey, entries) => {
      const store = new ShadowSecretStore(persistenceOf(master, aliasKey, entries));
      const decoyCtx = await store.getShadowContext('decoy');
      const nullCtx = await store.getShadowContext(null);
      const decoyEntries = await store.listAliasEntries('decoy');
      const nullEntries = await store.listAliasEntries(null);
      assert.equal(decoyCtx, nullCtx, 'context must be identical (both null) across decoy and null');
      assert.deepEqual(decoyEntries, nullEntries, 'entries must be identical (both []) across decoy and null');
    }),
    { numRuns: 200 },
  );
});
