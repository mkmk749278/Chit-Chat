import fc from 'fast-check';
import { describe, expect, test, vi } from 'vitest';

import { ShadowSecretStore, type AliasEntry, type ShadowThreadRef } from '@chat-app/crypto';

import {
  InMemoryShadowSecretPersistence,
  createWebShadowSecretStore,
  registerShadowSecretSessionEndWipe,
} from './shadow-secret-persistence';

/**
 * Web in-memory `ShadowSecretPersistence` adapter (Shadow Chat task 12.2, Requirements 9.5/9.8/9.9).
 *
 * Runs in jsdom so the real `window` unload lifecycle (`pagehide`/`beforeunload`) is present.
 * Verifies: in-memory round-trip of the master secret, alias key, and full alias-entry set including
 * each optional `pinVerifier`; the atomic-write (all-or-nothing) contract on the write paths; that
 * the store reads through the adapter in real-PIN mode but releases nothing in decoy/null mode; and
 * the session-end wipe.
 */

const bytes = (...v: number[]): Uint8Array => Uint8Array.from(v);

// A ref carrying an optional per-chat PIN verifier. The shipped `ShadowThreadRef` type does not yet
// name `pinVerifier` (added by a later core task), so we attach it via a typed widening to prove the
// adapter round-trips the full entry shape the design specifies (Requirement 9.9).
type RefWithPin = ShadowThreadRef & { pinVerifier?: string };

function entry(aliasHash: string, ref: RefWithPin): AliasEntry<ShadowThreadRef> {
  return { aliasHash, ref };
}

describe('InMemoryShadowSecretPersistence', () => {
  test('round-trips the master secret and alias key in memory (defensive copies)', async () => {
    const p = new InMemoryShadowSecretPersistence();
    expect(await p.loadMasterSecret()).toBeNull();
    expect(await p.loadAliasKey()).toBeNull();

    const master = bytes(1, 2, 3, 4);
    const alias = bytes(9, 8, 7);
    await p.saveMasterSecret(master);
    await p.saveAliasKey(alias);

    const loadedMaster = await p.loadMasterSecret();
    const loadedAlias = await p.loadAliasKey();
    expect(loadedMaster).toEqual(master);
    expect(loadedAlias).toEqual(alias);

    // Mutating the caller's source array or the returned copy must not corrupt stored state.
    master.fill(0);
    loadedAlias!.fill(0);
    expect(await p.loadMasterSecret()).toEqual(bytes(1, 2, 3, 4));
    expect(await p.loadAliasKey()).toEqual(bytes(9, 8, 7));
  });

  test('round-trips the full alias-entry set including the optional pinVerifier (9.9)', async () => {
    const p = new InMemoryShadowSecretPersistence();
    const withPin = entry('hashA', { peerUid: 'bob', threadId: 'tid-a', pinVerifier: 'pbkdf2$verifier' });
    const noPin = entry('hashB', { peerUid: 'carol', threadId: 'tid-b' });
    await p.saveAliasEntry(withPin);
    await p.saveAliasEntry(noPin);

    const loaded = await p.loadAliasEntries();
    expect(loaded).toHaveLength(2);
    const byHash = new Map(loaded.map((e) => [e.aliasHash, e.ref as RefWithPin]));
    expect(byHash.get('hashA')).toEqual({ peerUid: 'bob', threadId: 'tid-a', pinVerifier: 'pbkdf2$verifier' });
    expect(byHash.get('hashB')).toEqual({ peerUid: 'carol', threadId: 'tid-b' });
    expect((byHash.get('hashB') as RefWithPin).pinVerifier).toBeUndefined();
  });

  test('re-binding the same aliasHash replaces (never duplicates) the entry', async () => {
    const p = new InMemoryShadowSecretPersistence();
    await p.saveAliasEntry(entry('h', { peerUid: 'bob', threadId: 't1' }));
    await p.saveAliasEntry(entry('h', { peerUid: 'bob', threadId: 't2', pinVerifier: 'v' }));
    const loaded = await p.loadAliasEntries();
    expect(loaded).toHaveLength(1);
    expect((loaded[0].ref as RefWithPin)).toEqual({ peerUid: 'bob', threadId: 't2', pinVerifier: 'v' });
  });

  test('returned entries are isolated clones (mutation does not bleed back into the store)', async () => {
    const p = new InMemoryShadowSecretPersistence();
    await p.saveAliasEntry(entry('h', { peerUid: 'bob', threadId: 't1', pinVerifier: 'v' }));
    const first = await p.loadAliasEntries();
    (first[0].ref as RefWithPin).pinVerifier = 'tampered';
    const second = await p.loadAliasEntries();
    expect((second[0].ref as RefWithPin).pinVerifier).toBe('v');
  });

  test('atomic write: an invalid alias entry is rejected leaving nothing partial (9.7)', async () => {
    const p = new InMemoryShadowSecretPersistence();
    await p.saveAliasEntry(entry('good', { peerUid: 'bob', threadId: 't1' }));

    // Empty aliasHash must throw and must NOT mutate the stored set.
    await expect(p.saveAliasEntry(entry('', { peerUid: 'eve', threadId: 't2' }))).rejects.toThrow();
    const loaded = await p.loadAliasEntries();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].aliasHash).toBe('good');
  });

  test('destroy() wipes secrets and entries and rejects further writes', async () => {
    const p = new InMemoryShadowSecretPersistence();
    await p.saveMasterSecret(bytes(1, 2, 3));
    await p.saveAliasKey(bytes(4, 5));
    await p.saveAliasEntry(entry('h', { peerUid: 'bob', threadId: 't1' }));

    p.destroy();

    expect(await p.loadMasterSecret()).toBeNull();
    expect(await p.loadAliasKey()).toBeNull();
    expect(await p.loadAliasEntries()).toEqual([]);
    await expect(p.saveMasterSecret(bytes(9))).rejects.toThrow();
  });

  test('session-end wipe fires on pagehide and beforeunload, and unregister stops it', async () => {
    for (const eventType of ['pagehide', 'beforeunload'] as const) {
      const p = new InMemoryShadowSecretPersistence();
      await p.saveMasterSecret(bytes(1, 2, 3));
      const unregister = registerShadowSecretSessionEndWipe(p);
      window.dispatchEvent(new Event(eventType));
      expect(await p.loadMasterSecret()).toBeNull();
      unregister();
    }

    const p2 = new InMemoryShadowSecretPersistence();
    await p2.saveMasterSecret(bytes(7, 8));
    const unregister = registerShadowSecretSessionEndWipe(p2);
    unregister();
    window.dispatchEvent(new Event('pagehide'));
    expect(await p2.loadMasterSecret()).not.toBeNull();
  });
});

describe('createWebShadowSecretStore (boot provisioning)', () => {
  test('the provisioned store reads through the adapter only in real-PIN mode', async () => {
    const { persistence, store } = createWebShadowSecretStore();
    await persistence.saveMasterSecret(bytes(1, 2, 3, 4));
    await persistence.saveAliasKey(bytes(5, 6, 7, 8));
    await persistence.saveAliasEntry(entry('h', { peerUid: 'bob', threadId: 't1', pinVerifier: 'v' }));

    // real mode: releases the context and the entries (incl. pinVerifier).
    const ctx = await store.getShadowContext('real');
    expect(ctx).not.toBeNull();
    expect(ctx!.masterSecret).toEqual(bytes(1, 2, 3, 4));
    const entries = await store.listAliasEntries('real');
    expect(entries).toHaveLength(1);
    expect((entries[0].ref as RefWithPin).pinVerifier).toBe('v');

    // decoy / null modes: nothing is released, observationally identical.
    expect(await store.getShadowContext('decoy')).toBeNull();
    expect(await store.getShadowContext(null)).toBeNull();
    expect(await store.listAliasEntries('decoy')).toEqual([]);
    expect(await store.listAliasEntries(null)).toEqual([]);
  });

  test('a fresh store over the same persistence recovers the identical secrets and entries', async () => {
    const persistence = new InMemoryShadowSecretPersistence();
    await persistence.saveMasterSecret(bytes(10, 20, 30));
    await persistence.saveAliasKey(bytes(40, 50));
    await persistence.saveAliasEntry(entry('h1', { peerUid: 'bob', threadId: 't1', pinVerifier: 'v1' }));

    // Simulate a new store instance reading the same (session-durable) persistence.
    const fresh = new ShadowSecretStore(persistence);
    const ctx = await fresh.getShadowContext('real');
    expect(ctx!.masterSecret).toEqual(bytes(10, 20, 30));
    expect(ctx!.aliasKey).toEqual(bytes(40, 50));
    const entries = await fresh.listAliasEntries('real');
    expect(entries).toHaveLength(1);
    expect((entries[0].ref as RefWithPin).pinVerifier).toBe('v1');
  });

  test('fail-closed read path: a persistence error surfaces via onPersistenceError, releasing nothing', async () => {
    const persistence = new InMemoryShadowSecretPersistence();
    vi.spyOn(persistence, 'loadAliasEntries').mockRejectedValueOnce(new Error('boom'));
    const onPersistenceError = vi.fn();
    const store = new ShadowSecretStore(persistence, { onPersistenceError });

    expect(await store.listAliasEntries('real')).toEqual([]);
    expect(onPersistenceError).toHaveBeenCalledWith('listAliasEntries', expect.any(Error));
  });
});

describe('Property: in-memory persistence round-trip preserves master secret, alias key, entries', () => {
  test('arbitrary secrets + entry sets round-trip identically (incl. pinVerifier)', async () => {
    const refArb = fc.record(
      {
        peerUid: fc.string({ minLength: 1, maxLength: 16 }),
        threadId: fc.string({ minLength: 1, maxLength: 32 }),
        pinVerifier: fc.option(fc.string({ minLength: 1, maxLength: 24 }), { nil: undefined }),
      },
      { requiredKeys: ['peerUid', 'threadId'] },
    );
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 1, maxLength: 64 }),
        fc.uint8Array({ minLength: 1, maxLength: 64 }),
        fc.uniqueArray(
          fc.tuple(fc.string({ minLength: 1, maxLength: 24 }), refArb),
          { selector: ([hash]) => hash, maxLength: 25 },
        ),
        async (master, aliasKey, pairs) => {
          const persistence = new InMemoryShadowSecretPersistence();
          await persistence.saveMasterSecret(master);
          await persistence.saveAliasKey(aliasKey);
          for (const [aliasHash, ref] of pairs) {
            await persistence.saveAliasEntry({ aliasHash, ref });
          }

          const store = new ShadowSecretStore(persistence);
          const ctx = await store.getShadowContext('real');
          expect(ctx!.masterSecret).toEqual(master);
          expect(ctx!.aliasKey).toEqual(aliasKey);

          const loaded = await store.listAliasEntries('real');
          expect(loaded).toHaveLength(pairs.length);
          const expected = new Map(pairs.map(([h, r]) => [h, r]));
          for (const e of loaded) {
            expect(e.ref).toEqual(expected.get(e.aliasHash));
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
