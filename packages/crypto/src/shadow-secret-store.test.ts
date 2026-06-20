import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AliasEntry } from './shadow-chat';
import { deriveShadowThreadId, hashAlias } from './shadow-chat';
import {
  ShadowSecretStore,
  type ShadowSecretOperation,
  type ShadowSecretPersistence,
  type ShadowThreadRef,
} from './shadow-secret-store';

/**
 * Unit tests for the {@link ShadowSecretStore} (Shadow Chat, design Component 6; task 7.2).
 *
 * Covers: real-mode release of context + alias entries; decoy AND null modes return `null` / `[]`;
 * hash-only persistence (no plaintext/normalised alias anywhere in the backing store after a bind);
 * fail-closed reads on a persistence error in real mode (`getShadowContext` → `null`,
 * `listAliasEntries` → `[]`, with the error surfaced out-of-band); and fail-closed writes
 * (`bindAlias` / `putAlias` abort with nothing partial persisted) (Requirements 8.2, 8.3, 8.5, 8.7,
 * 9.1, 9.2, 9.4, 9.6, 9.7).
 */

const MASTER = Uint8Array.from({ length: 32 }, (_v, i) => (i * 53 + 7) & 0xff);
const ALIAS_KEY = Uint8Array.from({ length: 32 }, (_v, i) => (i * 17 + 1) & 0xff);

/**
 * An in-memory {@link ShadowSecretPersistence} fake. `saveAliasEntry` is atomic — it appends only
 * after the (optional) injected failure has been considered, so a thrown write leaves the entry set
 * untouched. `failOn` lets a test make a chosen operation throw to exercise the fail-closed paths.
 * `serialize()` returns a single string capturing EVERY stored byte/string so a test can assert no
 * plaintext alias leaked into any structure.
 */
interface FakePersistence extends ShadowSecretPersistence {
  entries: AliasEntry<ShadowThreadRef>[];
  failOn: Set<keyof ShadowSecretPersistence>;
  serialize(): string;
}

function fakePersistence(opts: { master?: Uint8Array | null; aliasKey?: Uint8Array | null } = {}): FakePersistence {
  const master = opts.master === undefined ? MASTER : opts.master;
  const aliasKey = opts.aliasKey === undefined ? ALIAS_KEY : opts.aliasKey;
  const entries: AliasEntry<ShadowThreadRef>[] = [];
  const failOn = new Set<keyof ShadowSecretPersistence>();
  const guard = (op: keyof ShadowSecretPersistence): void => {
    if (failOn.has(op)) {
      throw new Error(`fake-persistence: ${op} failed`);
    }
  };
  return {
    entries,
    failOn,
    async loadMasterSecret() {
      guard('loadMasterSecret');
      return master;
    },
    async saveMasterSecret() {
      guard('saveMasterSecret');
    },
    async loadAliasKey() {
      guard('loadAliasKey');
      return aliasKey;
    },
    async saveAliasKey() {
      guard('saveAliasKey');
    },
    async loadAliasEntries() {
      guard('loadAliasEntries');
      return entries.slice();
    },
    async saveAliasEntry(entry) {
      // Consider failure BEFORE mutating, so an aborted write leaves nothing partial persisted.
      guard('saveAliasEntry');
      entries.push(entry);
    },
    serialize() {
      return JSON.stringify({
        master: master ? Array.from(master) : null,
        aliasKey: aliasKey ? Array.from(aliasKey) : null,
        entries,
      });
    },
  };
}

test('real mode releases the shadow context (masterSecret + aliasKey)', async () => {
  const store = new ShadowSecretStore(fakePersistence());
  const ctx = await store.getShadowContext('real');
  assert.ok(ctx, 'expected a context in real mode');
  assert.deepEqual(ctx?.masterSecret, MASTER);
  assert.deepEqual(ctx?.aliasKey, ALIAS_KEY);
});

test('real mode releases the stored alias entries', async () => {
  const persistence = fakePersistence();
  const store = new ShadowSecretStore(persistence);
  const ref = await store.bindAlias('real', '/journal', 'bob', 'alice');
  assert.ok(ref);
  const entries = await store.listAliasEntries('real');
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.ref.peerUid, 'bob');
  assert.equal(entries[0]?.ref.threadId, ref?.threadId);
});

test('decoy AND null modes return no context and no entries (observationally identical)', async () => {
  const persistence = fakePersistence();
  const store = new ShadowSecretStore(persistence);
  // Seed an entry so there IS data to (not) reveal.
  await store.bindAlias('real', '/journal', 'bob', 'alice');

  for (const mode of ['decoy', null] as const) {
    assert.equal(await store.getShadowContext(mode), null, `getShadowContext should be null for ${mode}`);
    assert.deepEqual(await store.listAliasEntries(mode), [], `listAliasEntries should be [] for ${mode}`);
  }
  // bindAlias in a non-real mode resolves to null and persists nothing new.
  const before = persistence.entries.length;
  assert.equal(await store.bindAlias('decoy', '/work', 'carol', 'alice'), null);
  assert.equal(await store.bindAlias(null, '/work', 'carol', 'alice'), null);
  assert.equal(persistence.entries.length, before, 'non-real bindAlias must persist nothing');
});

test('bindAlias stores hash-only — no plaintext/normalised alias appears in the backing store', async () => {
  const persistence = fakePersistence();
  const store = new ShadowSecretStore(persistence);

  const ref = await store.bindAlias('real', '/SecretJournal', 'bob', 'alice');
  assert.ok(ref);

  // The stored entry's hash must equal the HMAC of the normalised alias, and only the hash + ref
  // are present — never the alias text in any form.
  const expectedHash = await hashAlias('/SecretJournal', ALIAS_KEY);
  assert.equal(persistence.entries.length, 1);
  assert.equal(persistence.entries[0]?.aliasHash, expectedHash);
  assert.match(persistence.entries[0]?.aliasHash ?? '', /^[0-9a-f]{64}$/);

  // Inspect EVERY stored byte/string: neither the raw nor the normalised alias may appear anywhere.
  const dump = persistence.serialize().toLowerCase();
  assert.ok(!dump.includes('secretjournal'), 'normalised alias body leaked into the backing store');
  assert.ok(!dump.includes('/secretjournal'), 'plaintext alias leaked into the backing store');

  // The derived threadId is the symmetric shadow thread id for the pair.
  const expectedThreadId = await deriveShadowThreadId(MASTER, 'alice', 'bob');
  assert.equal(ref?.threadId, expectedThreadId);
});

test('fail-closed: getShadowContext returns null and surfaces the error when persistence throws in real mode', async () => {
  const persistence = fakePersistence();
  const errors: ShadowSecretOperation[] = [];
  const store = new ShadowSecretStore(persistence, {
    onPersistenceError: (op) => errors.push(op),
  });
  persistence.failOn.add('loadMasterSecret');

  const ctx = await store.getShadowContext('real');
  assert.equal(ctx, null, 'must release no context on a persistence error');
  assert.deepEqual(errors, ['getShadowContext'], 'the error must be surfaced out-of-band');
});

test('fail-closed: listAliasEntries returns [] and surfaces the error when persistence throws in real mode', async () => {
  const persistence = fakePersistence();
  const errors: ShadowSecretOperation[] = [];
  const store = new ShadowSecretStore(persistence, {
    onPersistenceError: (op) => errors.push(op),
  });
  persistence.failOn.add('loadAliasEntries');

  const entries = await store.listAliasEntries('real');
  assert.deepEqual(entries, [], 'must release no entries on a persistence error');
  assert.deepEqual(errors, ['listAliasEntries']);
});

test('fail-closed: a half-provisioned store (missing aliasKey) releases no context', async () => {
  const store = new ShadowSecretStore(fakePersistence({ aliasKey: null }));
  assert.equal(await store.getShadowContext('real'), null);
});

test('fail-closed: bindAlias aborts (throws) and persists nothing when the write fails', async () => {
  const persistence = fakePersistence();
  const store = new ShadowSecretStore(persistence);
  persistence.failOn.add('saveAliasEntry');

  await assert.rejects(() => store.bindAlias('real', '/journal', 'bob', 'alice'), /saveAliasEntry failed/);
  assert.equal(persistence.entries.length, 0, 'a failed write must leave nothing partial persisted');
});

test('fail-closed: bindAlias aborts (throws) when loading the context fails — nothing persisted', async () => {
  const persistence = fakePersistence();
  const store = new ShadowSecretStore(persistence);
  persistence.failOn.add('loadAliasKey');

  await assert.rejects(() => store.bindAlias('real', '/journal', 'bob', 'alice'), /loadAliasKey failed/);
  assert.equal(persistence.entries.length, 0);
});

test('fail-closed: putAlias aborts (throws) and persists nothing when the write fails', async () => {
  const persistence = fakePersistence();
  const store = new ShadowSecretStore(persistence);
  const aliasHash = (await hashAlias('/journal', ALIAS_KEY)) as string;
  persistence.failOn.add('saveAliasEntry');

  await assert.rejects(
    () => store.putAlias({ aliasHash, ref: { peerUid: 'bob', threadId: 'tid' } }),
    /saveAliasEntry failed/,
  );
  assert.equal(persistence.entries.length, 0);
});

test('putAlias stores only the hash + ref (never a plaintext alias)', async () => {
  const persistence = fakePersistence();
  const store = new ShadowSecretStore(persistence);
  const aliasHash = (await hashAlias('/journal', ALIAS_KEY)) as string;

  await store.putAlias({ aliasHash, ref: { peerUid: 'bob', threadId: 'tid-1' } });
  assert.equal(persistence.entries.length, 1);
  assert.deepEqual(persistence.entries[0], { aliasHash, ref: { peerUid: 'bob', threadId: 'tid-1' } });
  const dump = persistence.serialize().toLowerCase();
  assert.ok(!dump.includes('journal'), 'plaintext alias must never be persisted via putAlias');
});

test('bindAlias returns null (binds nothing) in real mode when secrets are not provisioned', async () => {
  const persistence = fakePersistence({ master: null, aliasKey: null });
  const store = new ShadowSecretStore(persistence);
  assert.equal(await store.bindAlias('real', '/journal', 'bob', 'alice'), null);
  assert.equal(persistence.entries.length, 0);
});
