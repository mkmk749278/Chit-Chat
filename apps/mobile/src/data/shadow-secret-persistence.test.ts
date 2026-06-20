import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AliasEntry, ShadowThreadRef } from '@chat-app/crypto';

import type { PersistentVault } from '../crypto/persistent-store';
import { createVaultShadowSecretPersistence } from './shadow-secret-persistence';

/**
 * Mobile durable {@link ShadowSecretPersistence} adapter tests (Shadow Chat task 12.3, design
 * Component 6 "Durable encrypted persistence"; Requirements 9.7, 9.8, 9.9).
 *
 * Feature: shadow-chat. These run under the mobile `node --test` runner (the adapter is RN-free
 * orchestration over the injected vault, so it round-trips identically under Node and on-device).
 *
 * Focus — ATOMICITY (Requirement 9.7): using a fake {@link PersistentVault} whose `mutate` can be
 * made to throw mid-write, a failed write persists NO partial row and leaves the prior encrypted
 * document intact. The fake faithfully models the production vault's on-disk atomicity: the
 * encrypted document is a single serialized blob that `mutate` replaces all-or-nothing, and every
 * read deserialises from that committed blob — so a write that throws before the blob is committed
 * can never leak a partial mapping or corrupt the prior document. Also covers the durable
 * round-trip of the master secret, alias key, and full alias-entry set including each optional
 * `pinVerifier` (Requirements 9.8, 9.9).
 */

/**
 * A {@link ShadowThreadRef} widened with the optional per-chat PIN verifier. The shipped
 * `ShadowThreadRef` type does not yet declare `pinVerifier`; exactly as the web adapter test does,
 * we attach it via a local typed widening to prove the adapter round-trips the full entry shape the
 * design specifies (Requirement 9.9).
 */
type RefWithPin = ShadowThreadRef & { pinVerifier?: string };

/** The slice of the vault document the shadow adapter touches. */
interface ShadowDocShape {
  shadowSecrets?: {
    masterSecret?: string;
    aliasKey?: string;
    aliasEntries?: Array<{ aliasHash: string; ref: RefWithPin }>;
  };
}

/**
 * A fake encrypted {@link PersistentVault}. The committed document is held as ONE serialized blob
 * (modelling the production AES blob written via a single `blob.setItem`). `mutate` hydrates a
 * working copy from the committed blob, applies the mutation, re-serialises, and — only if the
 * injected mid-write failure is NOT armed — atomically replaces the committed blob. When
 * `failNextWrite` is armed, it throws AFTER applying the mutation to the throwaway working copy but
 * BEFORE committing, so the committed (encrypted) document is left byte-for-byte intact. `read`
 * always deserialises from the committed blob, so it can never observe an uncommitted partial write.
 */
class FakeEncryptedVault {
  private committed: string;
  /** Arm a single mid-write failure on the next `mutate`. */
  failNextWrite = false;
  /** Count of successful commits, so a test can assert no extra write slipped through. */
  commits = 0;

  constructor(initial: ShadowDocShape = {}) {
    this.committed = JSON.stringify(initial);
  }

  async read<T>(fn: (doc: ShadowDocShape) => T): Promise<T> {
    return fn(JSON.parse(this.committed) as ShadowDocShape);
  }

  async mutate<T>(fn: (doc: ShadowDocShape) => T): Promise<T> {
    const working = JSON.parse(this.committed) as ShadowDocShape;
    const result = fn(working);
    const serialized = JSON.stringify(working);
    if (this.failNextWrite) {
      this.failNextWrite = false;
      // Throw before committing: the prior encrypted blob is untouched (atomic all-or-nothing).
      throw new Error('fake-vault: simulated mid-write blob failure');
    }
    this.committed = serialized;
    this.commits += 1;
    return result;
  }

  release(): void {}

  async wipe(): Promise<void> {
    this.committed = JSON.stringify({});
  }

  /** The committed encrypted document, for asserting it stays intact across a failed write. */
  encryptedSnapshot(): string {
    return this.committed;
  }
}

/** Cast the fake to the production port (it implements the read/mutate surface the adapter uses). */
const asVault = (fake: FakeEncryptedVault): PersistentVault => fake as unknown as PersistentVault;

const bytes = (...v: number[]): Uint8Array => Uint8Array.from(v);

const entry = (aliasHash: string, ref: RefWithPin): AliasEntry<ShadowThreadRef> => ({ aliasHash, ref });

test('durable round-trip: master secret, alias key, and entries (incl. pinVerifier) survive via the vault (9.8, 9.9)', async () => {
  const fake = new FakeEncryptedVault();
  const adapter = createVaultShadowSecretPersistence(asVault(fake));

  assert.equal(await adapter.loadMasterSecret(), null, 'unprovisioned ⇒ null master secret');
  assert.equal(await adapter.loadAliasKey(), null, 'unprovisioned ⇒ null alias key');
  assert.deepEqual(await adapter.loadAliasEntries(), [], 'unprovisioned ⇒ no entries');

  await adapter.saveMasterSecret(bytes(1, 2, 3, 4));
  await adapter.saveAliasKey(bytes(9, 8, 7));
  await adapter.saveAliasEntry(entry('hashA', { peerUid: 'bob', threadId: 'tid-a', pinVerifier: 'pbkdf2$verifier' }));
  await adapter.saveAliasEntry(entry('hashB', { peerUid: 'carol', threadId: 'tid-b' }));

  // A FRESH adapter over the SAME committed (encrypted) document simulates a relaunch.
  const fresh = createVaultShadowSecretPersistence(asVault(fake));
  assert.deepEqual(await fresh.loadMasterSecret(), bytes(1, 2, 3, 4));
  assert.deepEqual(await fresh.loadAliasKey(), bytes(9, 8, 7));

  const loaded = await fresh.loadAliasEntries();
  assert.equal(loaded.length, 2);
  const byHash = new Map(loaded.map((e) => [e.aliasHash, e.ref as RefWithPin]));
  assert.deepEqual(byHash.get('hashA'), { peerUid: 'bob', threadId: 'tid-a', pinVerifier: 'pbkdf2$verifier' });
  assert.deepEqual(byHash.get('hashB'), { peerUid: 'carol', threadId: 'tid-b' });
  assert.equal((byHash.get('hashB') as RefWithPin).pinVerifier, undefined);
});

test('re-binding the same aliasHash replaces (never duplicates) the persisted row', async () => {
  const fake = new FakeEncryptedVault();
  const adapter = createVaultShadowSecretPersistence(asVault(fake));
  await adapter.saveAliasEntry(entry('h', { peerUid: 'bob', threadId: 't1' }));
  await adapter.saveAliasEntry(entry('h', { peerUid: 'bob', threadId: 't2', pinVerifier: 'v' }));

  const loaded = await adapter.loadAliasEntries();
  assert.equal(loaded.length, 1);
  assert.deepEqual(loaded[0].ref as RefWithPin, { peerUid: 'bob', threadId: 't2', pinVerifier: 'v' });
});

test('atomicity (9.7): a mid-write failure on saveAliasEntry persists NO partial row and leaves the prior document intact', async () => {
  const fake = new FakeEncryptedVault();
  const adapter = createVaultShadowSecretPersistence(asVault(fake));

  // Establish a prior, committed encrypted document with one bound alias + secrets.
  await adapter.saveMasterSecret(bytes(1, 2, 3, 4));
  await adapter.saveAliasKey(bytes(5, 6, 7, 8));
  await adapter.saveAliasEntry(entry('good', { peerUid: 'bob', threadId: 'tid-good', pinVerifier: 'v-good' }));
  const snapshotBefore = fake.encryptedSnapshot();
  const commitsBefore = fake.commits;

  // Arm a mid-write failure, then attempt to bind a second alias: it must abort (propagate).
  fake.failNextWrite = true;
  await assert.rejects(
    () => adapter.saveAliasEntry(entry('partial', { peerUid: 'eve', threadId: 'tid-eve' })),
    /simulated mid-write blob failure/,
  );

  // The committed encrypted document is byte-for-byte intact — no partial row, no extra commit.
  assert.equal(fake.encryptedSnapshot(), snapshotBefore, 'the prior encrypted document must be untouched');
  assert.equal(fake.commits, commitsBefore, 'a failed write must not commit');

  // Re-reading (and a fresh adapter, i.e. a relaunch) shows ONLY the prior row — the partial is absent.
  for (const reader of [adapter, createVaultShadowSecretPersistence(asVault(fake))]) {
    const loaded = await reader.loadAliasEntries();
    assert.equal(loaded.length, 1, 'no partial row may be persisted');
    assert.equal(loaded[0].aliasHash, 'good');
    assert.deepEqual(loaded[0].ref as RefWithPin, { peerUid: 'bob', threadId: 'tid-good', pinVerifier: 'v-good' });
    assert.deepEqual(await reader.loadMasterSecret(), bytes(1, 2, 3, 4), 'the master secret must be intact');
    assert.deepEqual(await reader.loadAliasKey(), bytes(5, 6, 7, 8), 'the alias key must be intact');
  }
});

test('atomicity (9.7): a mid-write failure on saveMasterSecret leaves the prior secrets/entries intact', async () => {
  const fake = new FakeEncryptedVault();
  const adapter = createVaultShadowSecretPersistence(asVault(fake));

  await adapter.saveMasterSecret(bytes(1, 1, 1));
  await adapter.saveAliasEntry(entry('h', { peerUid: 'bob', threadId: 't1' }));
  const snapshotBefore = fake.encryptedSnapshot();

  fake.failNextWrite = true;
  await assert.rejects(() => adapter.saveMasterSecret(bytes(2, 2, 2)), /simulated mid-write blob failure/);

  assert.equal(fake.encryptedSnapshot(), snapshotBefore, 'a failed master-secret write must leave the document intact');
  assert.deepEqual(await adapter.loadMasterSecret(), bytes(1, 1, 1), 'the prior master secret must survive a failed write');
  const loaded = await adapter.loadAliasEntries();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].aliasHash, 'h');
});
