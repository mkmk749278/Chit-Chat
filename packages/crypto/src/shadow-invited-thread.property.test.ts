import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import { deriveShadowThreadId, hashAlias, type AliasEntry } from './shadow-chat';
import {
  ShadowSecretStore,
  type InvitedThreadRef,
  type ShadowSecretPersistence,
  type ShadowThreadRef,
} from './shadow-secret-store';

/**
 * Property tests for the Shadow Chat Invites invited-thread binding (design "Component C:
 * ShadowSecretStore" and "Data Models → InvitedThreadRecord"; Requirements 2, 5, 7, 11).
 *
 * Feature: shadow-chat-invites.
 *
 * Validates four design Correctness Properties (see `.kiro/specs/shadow-chat-invites/design.md` →
 * "Correctness Properties"):
 *   - **Property 1 (Thread-key agreement / convergence):** ∀ 32-byte `key`, distinct non-empty
 *     `uidA, uidB`: `deriveShadowThreadId(key, uidA, uidB) === deriveShadowThreadId(key, uidB, uidA)`.
 *   - **Property 2 (Key uniqueness ⇒ thread uniqueness):** ∀ distinct keys `k1 ≠ k2`, same UID pair:
 *     distinct `threadId`s (overwhelming probability — per-thread compartmentalisation).
 *   - **Property 11 (Backward compatibility):** the legacy `bindAlias` derivation
 *     (`masterSecret` + alias) is byte-for-byte UNCHANGED by this feature.
 *   - **Property 17 (Revoked threads are non-re-derivable):** after `revokeShadowThread` there is NO
 *     persisted material from which `deriveShadowThreadId(threadKey, …)` can reproduce the `threadId`.
 *
 * Every property runs >=100 randomised iterations and reports fast-check's counterexample on failure.
 */

/** Arbitrary exactly-32-byte shared thread key (the invited-thread HMAC key). */
const keyArb: fc.Arbitrary<Uint8Array> = fc.uint8Array({ minLength: 32, maxLength: 32 });

/** Arbitrary non-empty secret bytes (legacy master secret / alias key). */
const secretArb: fc.Arbitrary<Uint8Array> = fc.uint8Array({ minLength: 1, maxLength: 64 });

/** Two distinct non-empty uids. */
const uidPairArb = fc
  .tuple(fc.string({ minLength: 1, maxLength: 16 }), fc.string({ minLength: 1, maxLength: 16 }))
  .filter(([a, b]) => a !== b);

/** Arbitrary grammatically-valid normalised alias (`/[a-z0-9]+`). */
const aliasArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), { minLength: 1, maxLength: 12 })
  .map((chars) => `/${chars.join('')}`);

test('Property 1: convergence — deriveShadowThreadId(key, a, b) === deriveShadowThreadId(key, b, a)', async () => {
  // Feature: shadow-chat-invites, Correctness Property 1 (thread-key agreement / convergence).
  await fc.assert(
    fc.asyncProperty(keyArb, uidPairArb, async (key, [uidA, uidB]) => {
      const ab = await deriveShadowThreadId(key, uidA, uidB);
      const ba = await deriveShadowThreadId(key, uidB, uidA);
      assert.equal(ab, ba, 'both peers must converge on the identical threadId from the shared key');
      assert.match(ab, /^[0-9a-f]{64}$/);
    }),
    { numRuns: 200 },
  );
});

test('Property 2: distinct shared keys ⇒ distinct threadId (same UID pair)', async () => {
  // Feature: shadow-chat-invites, Correctness Property 2 (key uniqueness ⇒ thread uniqueness).
  await fc.assert(
    fc.asyncProperty(keyArb, keyArb, uidPairArb, async (k1, k2, [uidA, uidB]) => {
      // Only meaningful when the two keys actually differ (overwhelmingly likely for random bytes).
      fc.pre(!equalBytes(k1, k2));
      const t1 = await deriveShadowThreadId(k1, uidA, uidB);
      const t2 = await deriveShadowThreadId(k2, uidA, uidB);
      assert.notEqual(t1, t2, 'distinct keys must yield distinct threadIds (compartmentalisation)');
    }),
    { numRuns: 200 },
  );
});

test('Property 11: legacy bindAlias derivation is byte-for-byte unchanged', async () => {
  // Feature: shadow-chat-invites, Correctness Property 11 (backward compatibility).
  // The legacy alias-only path derives threadId from the DEVICE-LOCAL masterSecret + alias. This
  // feature is purely additive (it adds an alias-FREE invited-thread path keyed by the SHARED key),
  // so a bindAlias-derived threadId must still equal the direct `deriveShadowThreadId(master, …, alias)`
  // exactly as before.
  await fc.assert(
    fc.asyncProperty(secretArb, secretArb, aliasArb, uidPairArb, async (master, aliasKey, alias, [myUid, peerUid]) => {
      const durable = durableFake(master, aliasKey);
      const store = new ShadowSecretStore(durable);

      const ref = await store.bindAlias('real', alias, peerUid, myUid);
      assert.ok(ref, 'real-mode bindAlias returns a ref');
      // The legacy derivation: device-local master secret + alias discriminator (myUid, peerUid).
      const expected = await deriveShadowThreadId(master, myUid, peerUid, alias);
      assert.equal(ref.threadId, expected, 'legacy bindAlias threadId must be byte-for-byte unchanged');
    }),
    { numRuns: 100 },
  );
});

test('Property 17: after revoke, no stored material remains to re-derive the threadId', async () => {
  // Feature: shadow-chat-invites, Correctness Property 17 (revoked threads are non-re-derivable).
  await fc.assert(
    fc.asyncProperty(
      secretArb,
      secretArb,
      keyArb,
      aliasArb,
      uidPairArb,
      async (master, aliasKey, threadKey, alias, [myUid, peerUid]) => {
        const durable = durableFake(master, aliasKey);
        const store = new ShadowSecretStore(durable);

        const bound = await store.bindInvitedThread('real', threadKey, peerUid, myUid, {
          alias,
          routing: 'hidden',
          inviteId: 'inv',
          state: 'active',
        });
        assert.ok(bound, 'real-mode bindInvitedThread returns a ref');
        const { threadId } = bound;

        // Sanity: the converged id is reproducible WHILE the shared key is stored.
        assert.equal(await deriveShadowThreadId(threadKey, myUid, peerUid), threadId);

        const revoked = await store.revokeShadowThread('real', threadId);
        assert.deepEqual(revoked, { peerUid, inviteId: 'inv' });

        // After revoke: no invited-thread record (⇒ no stored threadKey) and no AliasEntry for the
        // thread remain in the vault, so there is no persisted HMAC key from which the threadId can be
        // re-derived or reopened.
        const records = await durable.loadInvitedThreads();
        assert.equal(records.length, 0, 'no invited-thread record (hence no stored threadKey) remains');
        const entries = await durable.loadAliasEntries();
        assert.equal(
          entries.filter((e) => e.ref.threadId === threadId).length,
          0,
          'no AliasEntry for the revoked thread remains',
        );
      },
    ),
    { numRuns: 100 },
  );
});

/** Byte-array equality (used to skip the degenerate equal-key case in Property 2). */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * A durable in-memory {@link ShadowSecretPersistence} for the binding-path properties: a single
 * mutable backing store with atomic upsert/delete, mirroring the on-device encrypted vault. Alias
 * entries upsert by `aliasHash`; invited-thread records upsert by `threadId`; `deleteInvitedThread`
 * removes the record AND any alias entry pointing at the thread in one all-or-nothing step.
 */
function durableFake(master: Uint8Array, aliasKey: Uint8Array): ShadowSecretPersistence {
  const entries: AliasEntry<ShadowThreadRef>[] = [];
  const invited: InvitedThreadRef[] = [];
  return {
    async loadMasterSecret() {
      return master.slice();
    },
    async saveMasterSecret() {},
    async loadAliasKey() {
      return aliasKey.slice();
    },
    async saveAliasKey() {},
    async loadAliasEntries() {
      return entries.map((e) => ({ aliasHash: e.aliasHash, ref: { ...e.ref } }));
    },
    async saveAliasEntry(entry) {
      const at = entries.findIndex((e) => e.aliasHash === entry.aliasHash);
      const next = { aliasHash: entry.aliasHash, ref: { ...entry.ref } };
      if (at >= 0) {
        entries[at] = next;
      } else {
        entries.push(next);
      }
    },
    async saveInvitedThread(record) {
      const at = invited.findIndex((r) => r.threadId === record.threadId);
      const next: InvitedThreadRef = { ...record, threadKey: record.threadKey.slice() };
      if (at >= 0) {
        invited[at] = next;
      } else {
        invited.push(next);
      }
    },
    async loadInvitedThreads() {
      return invited.map((r) => ({ ...r, threadKey: r.threadKey.slice() }));
    },
    async deleteInvitedThread(threadId) {
      const recAt = invited.findIndex((r) => r.threadId === threadId);
      if (recAt >= 0) {
        invited.splice(recAt, 1);
      }
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        if (entries[i]?.ref.threadId === threadId) {
          entries.splice(i, 1);
        }
      }
    },
  };
}
